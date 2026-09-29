import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalQueue, agentRunnerConfig, goalSpawnArgs, runGoal, type RunnerConfig } from "../src/main/agent/runner";
import { SETUP_CREDENTIALS_JS } from "../src/main/agent/runtime-setup";
import type { GoalEnricher } from "../src/shared/agent-context";
import { SESSION_CONTEXT_BEGIN, SESSION_CONTEXT_END } from "../src/shared/agent-context";
import { isGoalFinal, type GoalState } from "../src/shared/agent-goal";

/**
 * Runner do cockpit (C2) contra um agente FAKE (tests/fixtures/fake-agent.sh)
 * — valida spawn/collect/timeout/fila sem rede e sem electron.
 */
describe("agentRunnerConfig", () => {
  it("defaults: runtime C2b (zcode + node24 do runtime dir), habilitado, timeout 15min, direct no linux", () => {
    const cfg = agentRunnerConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.agentBin).toBe(path.join(os.homedir(), ".local/state/voicecast/zcode-runtime", "zcode"));
    expect(cfg.nodeBin).toBe(path.join(os.homedir(), ".local/state/voicecast/zcode-runtime", "node24/bin/node"));
    expect(cfg.runtime).toBe(true);
    expect(cfg.runtimeDir).toBeUndefined();
    expect(cfg.timeoutMs).toBe(15 * 60_000);
    expect(cfg.direct).toBe(process.platform !== "win32");
  });

  it("windows (não-direct): paths WSL ($HOME expandido dentro do WSL), nunca paths Windows", () => {
    const win = agentRunnerConfig({}, "win32");
    expect(win.direct).toBe(false);
    expect(win.agentBin).toBe("$HOME/.local/state/voicecast/zcode-runtime/zcode");
    expect(win.nodeBin).toBe("$HOME/.local/state/voicecast/zcode-runtime/node24/bin/node");
    expect(win.runtime).toBe(true);
    expect(win.runtimeDir).toBeUndefined();
    // override de runtime dir (path WSL) é respeitado e repassado
    const custom = agentRunnerConfig({ VOICECAST_RUNTIME_DIR: "/home/x/custom-rt" }, "win32");
    expect(custom.agentBin).toBe("/home/x/custom-rt/zcode");
    expect(custom.runtimeDir).toBe("/home/x/custom-rt");
  });

  it("kill-switch e overrides por env (ZCODE_AGENT_BIN desliga o runtime setup)", () => {
    const off = agentRunnerConfig({ VOICECAST_AGENT_BRIDGE: "0" });
    expect(off.enabled).toBe(false);
    const cfg = agentRunnerConfig({ ZCODE_AGENT_BIN: "/x/y", ZCODE_AGENT_TIMEOUT_MS: "1000" });
    expect(cfg.agentBin).toBe("/x/y");
    expect(cfg.timeoutMs).toBe(1000);
    expect(cfg.runtime).toBe(false);
    expect(cfg.nodeBin).toBeUndefined();
  });

  it("goalSpawnArgs: direct usa argv; windows usa sh -lc com goal por ENV", () => {
    const cfg: RunnerConfig = { enabled: true, agentBin: "/home/x/zcode-agent", timeoutMs: 1, direct: true };
    const d = goalSpawnArgs(cfg, "abre um PR");
    expect(d.cmd).toBe("/home/x/zcode-agent");
    expect(d.args).toContain("-p");
    expect(d.args[d.args.indexOf("-p") + 1]).toBe("abre um PR");

    const w: RunnerConfig = { ...cfg, direct: false };
    const win = goalSpawnArgs(w, "goal com 'aspas' e $coisas");
    expect(win.cmd).toBe("wsl.exe");
    expect(win.env.VOICECAST_GOAL).toBe("goal com 'aspas' e $coisas");
    // goal nunca vai em argv do windows (injeção/aspas)
    expect(win.args.join(" ")).not.toContain("aspas");
  });

  it("goalSpawnArgs runtime direct: spawn é node24 do runtime + binário (nunca o node do sistema)", () => {
    const cfg: RunnerConfig = {
      enabled: true,
      agentBin: "/rt/zcode",
      nodeBin: "/rt/node24/bin/node",
      runtime: true,
      timeoutMs: 1,
      direct: true,
    };
    const rtEnv = { ZCODE_DATA_BASE_DIR: "/rt/zcode-data", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/rt/provider/zcode-builtin.json" };
    const d = goalSpawnArgs(cfg, "abre um PR", rtEnv);
    expect(d.cmd).toBe("/rt/node24/bin/node");
    expect(d.args[0]).toBe("/rt/zcode");
    expect(d.args).toContain("-p");
    expect(d.args[d.args.indexOf("-p") + 1]).toBe("abre um PR");
    // envs do runtime setup (data-dir curado) entram no spawn
    expect(d.env.ZCODE_DATA_BASE_DIR).toBe("/rt/zcode-data");
    expect(d.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe("/rt/provider/zcode-builtin.json");
  });

  it("goalSpawnArgs runtime windows: script WSL com paths $HOME, self-heal e exit 87; goal só por ENV", () => {
    const cfg: RunnerConfig = {
      enabled: true,
      agentBin: "$HOME/.local/state/voicecast/zcode-runtime/zcode",
      nodeBin: "$HOME/.local/state/voicecast/zcode-runtime/node24/bin/node",
      runtime: true,
      timeoutMs: 1,
      direct: false,
    };
    const win = goalSpawnArgs(cfg, "goal com 'aspas' e $coisas");
    expect(win.cmd).toBe("wsl.exe");
    const script = win.args[win.args.indexOf("-lc") + 1];
    // spawn é node24 do runtime + zcode do runtime (paths WSL)
    expect(script).toContain('"$RT/node24/bin/node" "$RT/zcode" --surface terminal -p "$VOICECAST_GOAL"');
    // self-heal de credentials roda dentro do WSL via node24 -e
    expect(script).toContain('-e "$VOICECAST_SETUP_JS"');
    expect(win.env.VOICECAST_SETUP_JS).toBe(SETUP_CREDENTIALS_JS);
    // pré-requisito ausente → exit code distinto (87)
    expect(script).toContain("exit 87");
    // goal nunca vai em argv (só por ENV) e nenhum path Windows aparece
    expect(win.args.join(" ")).not.toContain("aspas");
    expect(JSON.stringify(win.args)).not.toMatch(/[A-Za-z]:\\\\/);
    // override de runtime dir é repassado
    const win2 = goalSpawnArgs({ ...cfg, runtimeDir: "/home/x/custom-rt" }, "g");
    expect(win2.env.VOICECAST_RUNTIME_DIR).toBe("/home/x/custom-rt");
  });

  // W2b item 1: o goal roda no req.cwd nos DOIS caminhos (paridade WSL/Windows).
  it("W2b goalSpawnArgs windows: cwd resolvido p/ WSL vai por ENV (nunca argv) e o script faz cd", () => {
    const cfg: RunnerConfig = {
      enabled: true,
      agentBin: "$HOME/.local/state/voicecast/zcode-runtime/zcode",
      nodeBin: "$HOME/.local/state/voicecast/zcode-runtime/node24/bin/node",
      runtime: true,
      timeoutMs: 1,
      direct: false,
    };
    // modo runtime: path Windows vira /mnt/c/... no ENV
    const winRt = goalSpawnArgs(cfg, "g", undefined, "C:\\Users\\pedro\\Meu Proj");
    expect(winRt.env.VOICECAST_CWD).toBe("/mnt/c/Users/pedro/Meu Proj");
    const scriptRt = winRt.args[winRt.args.indexOf("-lc") + 1];
    expect(scriptRt.startsWith('if [ -n "$VOICECAST_CWD" ]; then cd "$VOICECAST_CWD"')).toBe(true);
    expect(scriptRt).toContain("exit 86"); // cd falhou → exit distinto do 87
    // modo legado (override): mesmo contrato
    const legacy: RunnerConfig = { enabled: true, agentBin: "/x/agent", timeoutMs: 1, direct: false };
    const winLegacy = goalSpawnArgs(legacy, "g", undefined, "C:\\Users\\pedro\\proj");
    expect(winLegacy.env.VOICECAST_CWD).toBe("/mnt/c/Users/pedro/proj");
    // path nunca interpolado no argv do wsl.exe (só o placeholder ENV no script)
    expect(winRt.args.join(" ")).not.toContain("/mnt/c");
    expect(winRt.args.join(" ")).not.toMatch(/[A-Za-z]:\\\\/);
    // sem cwd → sem ENV (script pula o cd pela guarda -n)
    const noCwd = goalSpawnArgs(cfg, "g");
    expect(noCwd.env.VOICECAST_CWD).toBeUndefined();
    // caminho direto: cwd é do spawn (runGoal), não do ENV
    const direct: RunnerConfig = { enabled: true, agentBin: "/x/agent", timeoutMs: 1, direct: true };
    expect(goalSpawnArgs(direct, "g", undefined, "/home/x/proj").env.VOICECAST_CWD).toBeUndefined();
  });
});

const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe("runGoal (agente fake)", () => {
  let bin: string;
  let cfg: RunnerConfig;

  beforeAll(() => {
    bin = path.join(import.meta.dirname, "fixtures", "fake-agent.sh");
    execFileSync("chmod", ["+x", bin]);
    cfg = { enabled: true, agentBin: bin, timeoutMs: 10_000, direct: true };
  });

  it("coleta stdout/stderr e exit 0 → completed", async () => {
    const r = await runGoal(
      { id: "1", goal: "teste", cwd: os.tmpdir() },
      { ...cfg, agentBin: bin },
    );
    expect(r.phase).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok do agente");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("W2b: goal roda no cwd pedido (caminho direto/WSL)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cwd-"));
    process.env.FAKE_PWD = "1";
    const r = await runGoal({ id: "w2b-cwd", goal: "x", cwd: dir }, cfg);
    delete process.env.FAKE_PWD;
    expect(r.phase).toBe("completed");
    expect(r.stdout).toContain(`pwd: ${dir}`);
  });

  it("exit != 0 → failed com stderr na cauda", async () => {
    setEnv("FAKE_EXIT", "3");
    const r = await runGoal({ id: "2", goal: "teste", cwd: os.tmpdir() }, cfg);
    setEnv("FAKE_EXIT", undefined);
    expect(r.phase).toBe("failed");
    expect(r.exitCode).toBe(3);
  });

  it("timeout mata o processo e devolve phase=timeout", async () => {
    setEnv("FAKE_SLEEP", "5");
    const r = await runGoal({ id: "3", goal: "x", cwd: os.tmpdir(), timeoutMs: 400 }, { ...cfg, timeoutMs: 400 });
    setEnv("FAKE_SLEEP", undefined);
    expect(r.phase).toBe("timeout");
    expect(r.error).toContain("timeout");
  });

  it("kill-switch devolve failed imediato sem spawn", async () => {
    const r = await runGoal({ id: "4", goal: "x", cwd: os.tmpdir() }, { ...cfg, enabled: false });
    expect(r.phase).toBe("failed");
    expect(r.error).toContain("VOICECAST_AGENT_BRIDGE");
  });

  it("C3: enrich injetado altera o goal que chega ao agente", async () => {
    const enrich: GoalEnricher = async (goal) => ({
      goal: `${goal}\n\n${SESSION_CONTEXT_BEGIN}\nfala da sessão\n${SESSION_CONTEXT_END}`,
      included: true,
      contextChars: 16,
    });
    process.env.FAKE_ECHO_ARGS = "1";
    const r = await runGoal({ id: "5", goal: "base", cwd: os.tmpdir(), enrich }, cfg);
    delete process.env.FAKE_ECHO_ARGS;
    expect(r.phase).toBe("completed");
    expect(r.stdout).toContain("base");
    expect(r.stdout).toContain(SESSION_CONTEXT_BEGIN);
    expect(r.stdout).toContain("fala da sessão");
    expect(r.stdout).toContain(SESSION_CONTEXT_END);
  });

  it("C3: enricher quebrado NUNCA quebra o goal (fail-soft)", async () => {
    const r = await runGoal({
      id: "6",
      goal: "base",
      cwd: os.tmpdir(),
      enrich: async () => {
        throw new Error("boom");
      },
    }, cfg);
    expect(r.phase).toBe("completed");
    expect(r.stdout).toContain("ok do agente");
  });
});

describe("GoalQueue", () => {
  let bin: string;
  let cfg: RunnerConfig;

  beforeAll(() => {
    bin = path.join(import.meta.dirname, "fixtures", "fake-agent.sh");
    cfg = { enabled: true, agentBin: bin, timeoutMs: 10_000, direct: true };
  });

  it("enfileira e roda serializando estados: queued→running→completed", async () => {
    const states: string[] = [];
    const q = new GoalQueue((s) => states.push(s.phase));
    expect(q.enqueue({ id: "a", goal: "g1", cwd: os.tmpdir() }, cfg)).toEqual({ ok: true });
    q.enqueue({ id: "b", goal: "g2", cwd: os.tmpdir() }, cfg);
    expect(q.enqueue({ id: "c", goal: "  ", cwd: os.tmpdir() }, cfg)).toEqual({ ok: false, error: "goal vazio" });
    await new Promise((r) => setTimeout(r, 800));
    expect(states).toContain("running");
    expect(states.filter((s) => s === "completed").length).toBeGreaterThanOrEqual(1);
  });

  it("recusa goal vazio e bridge off", () => {
    const q = new GoalQueue();
    expect(q.enqueue({ id: "x", goal: "  ", cwd: "." })).toEqual({ ok: false, error: "goal vazio" });
    expect(q.enqueue({ id: "y", goal: "g", cwd: "." }, { enabled: false, agentBin: "", timeoutMs: 1, direct: true }).ok).toBe(false);
  });

  it("C3: enricher injetado no GoalQueue chega ao agente pelo goal enriquecido", async () => {
    const enrich: GoalEnricher = async (goal) => ({
      goal: `${goal}\n\n${SESSION_CONTEXT_BEGIN}\ncontexto pela fila\n${SESSION_CONTEXT_END}`,
      included: true,
      contextChars: 18,
    });
    const finals: GoalState[] = [];
    const q = new GoalQueue((s) => {
      if (isGoalFinal(s.phase)) finals.push(s);
    }, enrich);
    process.env.FAKE_ECHO_ARGS = "1";
    q.enqueue({ id: "c3", goal: "goal da fila", cwd: os.tmpdir() }, cfg);
    await new Promise((r) => setTimeout(r, 800));
    delete process.env.FAKE_ECHO_ARGS;
    expect(finals.some((s) => s.phase === "completed")).toBe(true);
    const done = finals.find((s) => s.phase === "completed");
    expect(done?.lastOutput).toContain(SESSION_CONTEXT_BEGIN);
    expect(done?.lastOutput).toContain("contexto pela fila");
  });
});
