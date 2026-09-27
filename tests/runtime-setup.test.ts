import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  RuntimeSetupError,
  SETUP_CREDENTIALS_JS,
  defaultRuntimePaths,
  ensureRuntime,
  injectIdentityKeys,
  resetRuntimeCache,
  type RuntimePaths,
} from "../src/main/agent/runtime-setup";

/**
 * Runtime setup (C2b): materialização do runtime do agente U1/U2 em dir
 * próprio — copia idempotente, self-heal por mtime, erro claro sem build e
 * segredos nunca em stdout. Fixtures em tmp; ~/.zcode nunca é tocado.
 */

const SECRET = "enc:v1:SuperSecretoNaoPodeVazar";

function mkFixture(): { root: string; paths: RuntimePaths; credSrc: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-runtime-"));
  const buildDir = path.join(root, "build");
  fs.mkdirSync(path.join(buildDir, "node24", "bin"), { recursive: true });
  fs.mkdirSync(path.join(buildDir, "provider"), { recursive: true });
  fs.writeFileSync(path.join(buildDir, "zcode"), "#!/bin/sh\necho fake-cli\n");
  fs.writeFileSync(path.join(buildDir, "node24", "bin", "node"), "#!/bin/sh\necho fake-node\n");
  fs.writeFileSync(path.join(buildDir, "provider", "zcode-builtin.json"), '{"revision":30}');
  const credSrc = path.join(root, "credentials.json");
  fs.writeFileSync(
    credSrc,
    JSON.stringify({
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:UUID-INDIVIDUAL:api-key": SECRET,
      "account-provider:coding-plan:account:zai-team-plan:account:UUID-TEAM:api-key": SECRET,
      "outra:chave": SECRET,
    }),
  );
  return {
    root,
    paths: {
      buildDir,
      runtimeDir: path.join(root, "runtime"),
      credentialsSrc: credSrc,
      personalProviderSrc: path.join(root, "provider_config.json"),
    },
    credSrc,
  };
}

let fx: ReturnType<typeof mkFixture>;

beforeEach(() => {
  fx = mkFixture();
  resetRuntimeCache();
});

afterEach(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const dstCred = () => path.join(fx.paths.runtimeDir, "zcode-data", ".zcode", "v2", "credentials.json");

describe("injectIdentityKeys", () => {
  it("injeta identity para cada api-key (valor = uuid do nome da chave)", () => {
    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(fx.credSrc, "utf8"));
    const added = injectIdentityKeys(data);
    expect(added).toBe(2);
    expect(data["account-provider:account:zai-individual-coding-plan:identity"]).toBe("UUID-INDIVIDUAL");
    expect(data["account-provider:account:zai-team-plan:identity"]).toBe("UUID-TEAM");
    // api-key original intocada
    expect(data["account-provider:coding-plan:account:zai-individual-coding-plan:account:UUID-INDIVIDUAL:api-key"]).toBe(SECRET);
  });

  it("é idempotente (segunda passada não adiciona nada)", () => {
    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(fx.credSrc, "utf8"));
    injectIdentityKeys(data);
    expect(injectIdentityKeys(data)).toBe(0);
  });
});

describe("ensureRuntime", () => {
  it("primeira execução: copia binários+provider, monta data-dir com identity, envs prontos", async () => {
    const r = await ensureRuntime(fx.paths);
    expect(r.resultado).toBe("ok");
    expect(r.agentBin).toBe(path.join(fx.paths.runtimeDir, "zcode"));
    expect(r.nodeBin).toBe(path.join(fx.paths.runtimeDir, "node24", "bin", "node"));
    // permissões
    const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);
    expect(mode(r.agentBin)).toBe("755");
    expect(mode(dstCred())).toBe("600");
    // conteúdo curado
    const cred = JSON.parse(fs.readFileSync(dstCred(), "utf8"));
    expect(cred["account-provider:account:zai-individual-coding-plan:identity"]).toBe("UUID-INDIVIDUAL");
    // envs
    expect(r.env.ZCODE_DATA_BASE_DIR).toBe(path.join(fx.paths.runtimeDir, "zcode-data"));
    expect(r.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(path.join(fx.paths.runtimeDir, "provider", "zcode-builtin.json"));
    expect(r.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBeUndefined();
    // provider config presente
    expect(fs.existsSync(r.providerConfigFile)).toBe(true);
  });

  it("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE entra no env quando o arquivo existe", async () => {
    fs.writeFileSync(fx.paths.personalProviderSrc, "{}");
    const r = await ensureRuntime(fx.paths);
    expect(r.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(fx.paths.personalProviderSrc);
  });

  it("segunda execução sem mudanças: idempotente, nada é re-escrito", async () => {
    await ensureRuntime(fx.paths);
    const mtime1 = fs.statSync(dstCred()).mtimeMs;
    const r2 = await ensureRuntime(fx.paths);
    expect(r2.resultado).toBe("ok");
    expect(fs.statSync(dstCred()).mtimeMs).toBe(mtime1);
  });

  it("self-heal: mtime do original mais novo → re-copia (resultado stale)", async () => {
    await ensureRuntime(fx.paths);
    // desktop "rotacionou": conteúdo novo + mtime futuro
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(
      fx.credSrc,
      JSON.stringify({
        "account-provider:coding-plan:account:zai-individual-coding-plan:account:UUID-NOVO:api-key": SECRET,
        probe: "v2",
      }),
    );
    fs.utimesSync(fx.credSrc, future, future);
    const r = await ensureRuntime(fx.paths);
    expect(r.resultado).toBe("stale");
    const cred = JSON.parse(fs.readFileSync(dstCred(), "utf8"));
    expect(cred["account-provider:account:zai-individual-coding-plan:identity"]).toBe("UUID-NOVO");
    expect(cred["probe"]).toBe("v2");
  });

  it("refresh do binário (rebuild mais novo) também marca stale", async () => {
    await ensureRuntime(fx.paths);
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(fx.paths.buildDir, "zcode"), "#!/bin/sh\necho fake-cli-v2\n");
    fs.utimesSync(path.join(fx.paths.buildDir, "zcode"), future, future);
    const r = await ensureRuntime(fx.paths);
    expect(r.resultado).toBe("stale");
    expect(fs.readFileSync(r.agentBin, "utf8")).toContain("fake-cli-v2");
  });

  it("build ausente (runtime vazio) → RuntimeSetupError SEM_BUILD com mensagem orientando o U1", async () => {
    fs.rmSync(fx.paths.buildDir, { recursive: true, force: true });
    const err = await ensureRuntime(fx.paths).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeSetupError);
    expect(err.code).toBe("SEM_BUILD");
    expect(err.message).toContain("U1");
  });

  it("durável: runtime já materializado não exige o buildDir (sobrevive a reboot de /tmp)", async () => {
    await ensureRuntime(fx.paths);
    fs.rmSync(fx.paths.buildDir, { recursive: true, force: true });
    const r = await ensureRuntime(fx.paths);
    expect(r.resultado).toBe("ok");
    expect(fs.existsSync(r.agentBin)).toBe(true);
  });

  it("credentials ausentes → RuntimeSetupError SEM_CREDENCIAL", async () => {
    fs.rmSync(fx.credSrc);
    const err = await ensureRuntime(fx.paths).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeSetupError);
    expect(err.code).toBe("SEM_CREDENCIAL");
  });

  it("segredos nunca vão para stdout/stderr (nada é impresso)", async () => {
    const spy = vi.spyOn(console, "log");
    const spyInfo = vi.spyOn(console, "info");
    const spyWarn = vi.spyOn(console, "warn");
    const spyErr = vi.spyOn(console, "error");
    await ensureRuntime(fx.paths);
    await ensureRuntime(fx.paths); // roda de novo (stale/idempotente)
    for (const s of [spy, spyInfo, spyWarn, spyErr]) {
      for (const call of s.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET);
        expect(JSON.stringify(call)).not.toContain("UUID-");
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SETUP_CREDENTIALS_JS (self-heal dentro do WSL no Windows)", () => {
  it("produz o MESMO resultado do caminho TS (paridade)", () => {
    const outBase = path.join(fx.root, "via-js");
    execFileSync(process.execPath, ["-e", SETUP_CREDENTIALS_JS, fx.credSrc, outBase], { encoding: "utf8" });
    const viaJs = JSON.parse(fs.readFileSync(path.join(outBase, ".zcode", "v2", "credentials.json"), "utf8"));

    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(fx.credSrc, "utf8"));
    injectIdentityKeys(data);
    for (const k of Object.keys(viaJs)) {
      expect(viaJs[k]).toEqual(data[k]);
    }
    expect(Object.keys(viaJs).sort()).toEqual(Object.keys(data).sort());
  });

  it("exit 87 quando o credentials de origem não existe", () => {
    let code = 0;
    try {
      execFileSync(process.execPath, ["-e", SETUP_CREDENTIALS_JS, path.join(fx.root, "falta.json"), path.join(fx.root, "x")]);
    } catch (e) {
      code = (e as { status?: number }).status ?? 0;
    }
    expect(code).toBe(87);
  });

  it("idempotente por mtime: segunda execução não reescreve", () => {
    const outBase = path.join(fx.root, "via-js2");
    execFileSync(process.execPath, ["-e", SETUP_CREDENTIALS_JS, fx.credSrc, outBase]);
    const dst = path.join(outBase, ".zcode", "v2", "credentials.json");
    const mtime1 = fs.statSync(dst).mtimeMs;
    execFileSync(process.execPath, ["-e", SETUP_CREDENTIALS_JS, fx.credSrc, outBase]);
    expect(fs.statSync(dst).mtimeMs).toBe(mtime1);
    expect((fs.statSync(dst).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("defaultRuntimePaths", () => {
  it("defaults: build em /tmp/zcode-cli-build e runtime em ~/.local/state/voicecast", () => {
    const p = defaultRuntimePaths({});
    expect(p.buildDir).toBe("/tmp/zcode-cli-build");
    expect(p.runtimeDir).toBe(path.join(os.homedir(), ".local", "state", "voicecast", "zcode-runtime"));
    expect(p.credentialsSrc).toBe(path.join(os.homedir(), ".zcode", "v2", "credentials.json"));
  });

  it("envs sobrescrevem build/runtime dirs", () => {
    const p = defaultRuntimePaths({ VOICECAST_ZCODE_BUILD_DIR: "/b", VOICECAST_RUNTIME_DIR: "/r" });
    expect(p.buildDir).toBe("/b");
    expect(p.runtimeDir).toBe("/r");
  });
});
