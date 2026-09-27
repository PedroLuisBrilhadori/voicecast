import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalQueue, agentRunnerConfig, goalSpawnArgs, runGoal, type RunnerConfig } from "../src/main/agent/runner";
import { SETUP_CREDENTIALS_JS } from "../src/main/agent/runtime-setup";

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
});
