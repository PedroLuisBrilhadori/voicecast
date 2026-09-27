/**
 * Runtime setup do agente ZCode (C2b): materializa e mantém, em
 * ~/.local/state/voicecast/zcode-runtime/, o CLI buildado do open source
 * (U1) + um data-dir próprio auto-curado (U2) — tornando durável o
 * desbloqueio do goal headless.
 *
 * Causa raiz do bloqueio (BUILD.md, seção U2): a síntese standalone de
 * account providers EXIGE a chave de credencial
 * `account-provider:<providerId>:identity`, que o desktop NÃO grava. Sem ela
 * o provider sai `entitled: false` e o `-p` morre em "Select a model before
 * continuing". O setup copia o credentials.json de ~/.zcode/v2/ (SOMENTE
 * LEITURA) para o data-dir próprio e injeta as identity keys (idempotente;
 * re-copia se o mtime do original mudar = self-heal se o desktop rotacionar).
 *
 * Envs que o runner recebe daqui:
 * - ZCODE_DATA_BASE_DIR  → <runtimeDir>/zcode-data (credentials em .zcode/v2/)
 * - ZCODE_BUILTIN_PROVIDER_CONFIG_FILE → <runtimeDir>/provider/zcode-builtin.json
 * - ZCODE_PERSONAL_PROVIDER_CONFIG_FILE → ~/.zcode/v2/provider_config.json (se existir)
 *
 * Telemetria: counter voicecast_agent_runtime_setup_total{resultado}
 * (ok | stale | sem-build | sem-credencial). NUNCA loga segredos — o módulo
 * não imprime nada; só contagens/paths.
 *
 * Puro Node (sem electron) — testável em qualquer SO com paths explícitos.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { counter } from "../telemetry";

const M_SETUP = counter(
  "voicecast_agent_runtime_setup_total",
  "runtime setup do agente por resultado (ok|stale|sem-build|sem-credencial)",
);

/** Exit code distinto para pré-requisito ausente (sem build U1 / sem credenciais). */
export const RUNTIME_SETUP_EXIT_MISSING_PREREQ = 87;

export type RuntimeSetupResultado = "ok" | "stale" | "sem-build" | "sem-credencial";

export interface RuntimePaths {
  /** Build do CLI open source (U1): contém zcode, node24/ e provider/. */
  buildDir: string;
  /** Diretório do runtime materializado (persistente — não usar /tmp). */
  runtimeDir: string;
  /** Credentials do desktop (somente leitura). */
  credentialsSrc: string;
  /** Provider config pessoal do desktop (somente leitura; opcional). */
  personalProviderSrc: string;
}

export interface RuntimeSetupResult {
  resultado: RuntimeSetupResultado;
  nodeBin: string;
  agentBin: string;
  providerConfigFile: string;
  dataBaseDir: string;
  /** Envs prontos para o spawn do goal. */
  env: Record<string, string>;
}

export class RuntimeSetupError extends Error {
  constructor(
    readonly code: "SEM_BUILD" | "SEM_CREDENCIAL",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSetupError";
  }
}

/** Chave api-key gravada pelo desktop → identity key exigida pela síntese standalone (U2). */
const API_KEY_KEY = /^account-provider:coding-plan:(account:[^:]+):account:([^:]+):api-key$/;

/**
 * Injeta as identity keys no mapa de credenciais (PURE — muta o objeto).
 * Valor = o UUID que já aparece no NOME da chave api-key (identificador de
 * conta, não segredo de request). Idempotente: só adiciona se ausente.
 * @returns quantas keys foram adicionadas.
 */
export function injectIdentityKeys(data: Record<string, unknown>): number {
  let added = 0;
  for (const k of Object.keys(data)) {
    const m = API_KEY_KEY.exec(k);
    if (!m) continue;
    const identityKey = `account-provider:${m[1]}:identity`;
    if (!Object.prototype.hasOwnProperty.call(data, identityKey)) {
      data[identityKey] = m[2];
      added++;
    }
  }
  return added;
}

export function defaultRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const home = os.homedir();
  return {
    buildDir: env.VOICECAST_ZCODE_BUILD_DIR || "/tmp/zcode-cli-build",
    runtimeDir: env.VOICECAST_RUNTIME_DIR || path.join(home, ".local", "state", "voicecast", "zcode-runtime"),
    credentialsSrc: path.join(home, ".zcode", "v2", "credentials.json"),
    personalProviderSrc: path.join(home, ".zcode", "v2", "provider_config.json"),
  };
}

async function statIf(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await statIf(p)) !== null;
}

/** Copia `src` → `dst` (arquivo) se dst ausente ou src mais novo/size diff. @returns true se re-copiou por cima de dst existente. */
async function copyIfStale(src: string, dst: string, mode?: number): Promise<boolean> {
  const s = await statIf(src);
  const d = await statIf(dst);
  if (!d) {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    if (mode !== undefined) await fs.promises.chmod(dst, mode);
    return false; // provisionamento novo
  }
  if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
    await fs.promises.copyFile(src, dst);
    if (mode !== undefined) await fs.promises.chmod(dst, mode);
    return true; // refresh sobre material existente
  }
  return false;
}

/**
 * Garante o runtime completo (binários + provider + credentials auto-curado).
 * Idempotente e self-heal por mtime. DURÁVEL: se o runtime já está completo,
 * o buildDir não é exigido (só serve para materializar/refresh).
 * Erros: RuntimeSetupError SEM_BUILD (pré-requisito U1 ausente) /
 * SEM_CREDENCIAL (usuário sem login no desktop). Nunca imprime segredos.
 */
export async function ensureRuntime(paths: RuntimePaths = defaultRuntimePaths()): Promise<RuntimeSetupResult> {
  const { buildDir, runtimeDir, credentialsSrc, personalProviderSrc } = paths;
  const srcZcode = path.join(buildDir, "zcode");
  const srcNode = path.join(buildDir, "node24", "bin", "node");
  const srcProvider = path.join(buildDir, "provider", "zcode-builtin.json");
  const dstZcode = path.join(runtimeDir, "zcode");
  const dstNode = path.join(runtimeDir, "node24", "bin", "node");
  const dstProvider = path.join(runtimeDir, "provider", "zcode-builtin.json");

  const semBuild = (what: string): never => {
    M_SETUP?.add(1, { resultado: "sem-build" });
    throw new RuntimeSetupError(
      "SEM_BUILD",
      `runtime do agente incompleto (${what}); materialize o build do U1 em ${buildDir} ` +
        `(exit code de pré-requisito ausente: ${RUNTIME_SETUP_EXIT_MISSING_PREREQ}) — ver docs/wp/U1-build-cli.md`,
    );
  };

  let refreshed = false;

  // 1. binário zcode (esbuild p/ node 24)
  if (!(await exists(dstZcode))) {
    if (!(await exists(srcZcode))) semBuild("binário zcode ausente");
    if (await copyIfStale(srcZcode, dstZcode, 0o755)) refreshed = true;
  } else {
    const s = await statIf(srcZcode);
    const d = (await statIf(dstZcode))!;
    if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
      await fs.promises.copyFile(srcZcode, dstZcode);
      await fs.promises.chmod(dstZcode, 0o755);
      refreshed = true;
    }
  }

  // 2. node24/ (o binário é esbuild — spawn SEMPRE com este node, nunca o do sistema)
  if (!(await exists(dstNode))) {
    if (!(await exists(srcNode))) semBuild("runtime node24 ausente");
    await fs.promises.rm(path.join(runtimeDir, "node24"), { recursive: true, force: true });
    await fs.promises.cp(path.join(buildDir, "node24"), path.join(runtimeDir, "node24"), { recursive: true });
  } else {
    const s = await statIf(srcNode);
    const d = (await statIf(dstNode))!;
    if (s && s.mtimeMs > d.mtimeMs) {
      await fs.promises.rm(path.join(runtimeDir, "node24"), { recursive: true, force: true });
      await fs.promises.cp(path.join(buildDir, "node24"), path.join(runtimeDir, "node24"), { recursive: true });
      refreshed = true;
    }
  }

  // 3. provider config bundled (fallback/early-return do CLI — BUILD.md U1)
  if (!(await exists(dstProvider))) {
    if (!(await exists(srcProvider))) semBuild("provider/zcode-builtin.json ausente");
    if (await copyIfStale(srcProvider, dstProvider)) refreshed = true;
  } else {
    const s = await statIf(srcProvider);
    const d = (await statIf(dstProvider))!;
    if (s && (s.mtimeMs > d.mtimeMs || s.size !== d.size)) {
      await fs.promises.copyFile(srcProvider, dstProvider);
      refreshed = true;
    }
  }

  // 4. data-dir próprio com credentials auto-curado (U2) — ~/.zcode somente leitura
  const dataBaseDir = path.join(runtimeDir, "zcode-data");
  const dstCred = path.join(dataBaseDir, ".zcode", "v2", "credentials.json");
  if (!(await exists(credentialsSrc))) {
    M_SETUP?.add(1, { resultado: "sem-credencial" });
    throw new RuntimeSetupError(
      "SEM_CREDENCIAL",
      `credentials ausentes em ${credentialsSrc} — faça login no desktop zcode antes de rodar goals`,
    );
  }
  let credStale = false;
  const dstCredStat = await statIf(dstCred);
  const srcCredStat = (await statIf(credentialsSrc))!;
  if (!dstCredStat || srcCredStat.mtimeMs > dstCredStat.mtimeMs) {
    // NUNCA logar conteúdo — lê, injeta identity keys e grava com 600.
    const data = JSON.parse(await fs.promises.readFile(credentialsSrc, "utf8")) as Record<string, unknown>;
    injectIdentityKeys(data);
    await fs.promises.mkdir(path.dirname(dstCred), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(dstCred, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.chmod(dstCred, 0o600);
    for (const dir of [dataBaseDir, path.join(dataBaseDir, ".zcode"), path.dirname(dstCred)]) {
      await fs.promises.chmod(dir, 0o700).catch(() => {});
    }
    credStale = dstCredStat !== null; // re-cópia sobre material existente = self-heal
  }

  const resultado: RuntimeSetupResultado = refreshed || credStale ? "stale" : "ok";
  const env: Record<string, string> = {
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: dstProvider,
  };
  if (await exists(personalProviderSrc)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalProviderSrc;
  M_SETUP?.add(1, { resultado });
  return { resultado, nodeBin: dstNode, agentBin: dstZcode, providerConfigFile: dstProvider, dataBaseDir, env };
}

// --- Cache por processo: self-heal roda 1x por start do bridge ("a cada start") ---

let cached: Promise<RuntimeSetupResult> | null = null;

/** ensureRuntime com cache por processo (falha não fica em cache — retry no próximo goal). */
export function ensureRuntimeCached(paths: RuntimePaths = defaultRuntimePaths()): Promise<RuntimeSetupResult> {
  if (!cached) {
    cached = ensureRuntime(paths).catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** Só para testes: limpa o cache por processo. */
export function resetRuntimeCache(): void {
  cached = null;
}

/**
 * Mesma lógica de sync de credentials, como programa standalone (CommonJS,
 * sem imports) para o SELF-HEAL dentro do WSL no spawn Windows: o script sh
 * roda `node24 -e $VOICECAST_SETUP_JS <credentials-src> <data-base-dir>`.
 * Paridade com injectIdentityKeys garantida por teste (mesma saída).
 */
export const SETUP_CREDENTIALS_JS = `
const fs = require("fs"), path = require("path");
const src = process.argv[1], base = process.argv[2];
if (!src || !base) { console.error("uso: node -e <script> <credentials-src> <data-base-dir>"); process.exit(64); }
if (!fs.existsSync(src)) { console.error("voicecast-agent: credentials ausentes: " + src); process.exit(87); }
const dstDir = path.join(base, ".zcode", "v2");
const dst = path.join(dstDir, "credentials.json");
fs.mkdirSync(dstDir, { recursive: true });
if (fs.existsSync(dst) && fs.statSync(src).mtimeMs <= fs.statSync(dst).mtimeMs) process.exit(0);
const data = JSON.parse(fs.readFileSync(src, "utf8"));
let added = 0;
for (const k of Object.keys(data)) {
  const m = /^account-provider:coding-plan:(account:[^:]+):account:([^:]+):api-key$/.exec(String(k));
  if (m && !Object.prototype.hasOwnProperty.call(data, "account-provider:" + m[1] + ":identity")) {
    data["account-provider:" + m[1] + ":identity"] = m[2];
    added += 1;
  }
}
fs.writeFileSync(dst, JSON.stringify(data, null, 2) + "\\n", { mode: 0o600 });
fs.chmodSync(dst, 0o600);
console.log("voicecast-agent: credentials sincronizados (identity+" + added + ")");
`.trim();
