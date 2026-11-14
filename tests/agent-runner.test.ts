import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalQueue, agentRunnerConfig, goalSpawnArgs, goalSummary as goalSummaryDoRunner, runGoal, type RunnerConfig } from "../src/main/agent/runner";
import { SETUP_CREDENTIALS_JS } from "../src/main/agent/runtime-setup";
import type { GoalEnricher } from "../src/shared/agent-context";
import { SESSION_CONTEXT_BEGIN, SESSION_CONTEXT_END } from "../src/shared/agent-context";
import { goalSummary as goalSummaryDaFonte, isGoalFinal, type GoalState } from "../src/shared/agent-goal";

/**
 * Cockpit runner (C2) against a FAKE agent (tests/fixtures/fake-agent.sh)
 * — validates spawn/collect/timeout/queue without network and without electron.
 */
describe("agentRunnerConfig", () => {
  it("defaults: C2b runtime (zcode + node24 from the runtime dir), enabled, 15min timeout, direct on linux", () => {
    const cfg = agentRunnerConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.agentBin).toBe(path.join(os.homedir(), ".local/state/voicecast/zcode-runtime", "zcode"));
    expect(cfg.nodeBin).toBe(path.join(os.homedir(), ".local/state/voicecast/zcode-runtime", "node24/bin/node"));
    expect(cfg.runtime).toBe(true);
    expect(cfg.runtimeDir).toBeUndefined();
    expect(cfg.timeoutMs).toBe(15 * 60_000);
    expect(cfg.direct).toBe(process.platform !== "win32");
  });

  it("windows (non-direct): WSL paths ($HOME expanded inside WSL), never Windows paths", () => {
    const win = agentRunnerConfig({}, "win32");
    expect(win.direct).toBe(false);
    expect(win.agentBin).toBe("$HOME/.local/state/voicecast/zcode-runtime/zcode");
    expect(win.nodeBin).toBe("$HOME/.local/state/voicecast/zcode-runtime/node24/bin/node");
    expect(win.runtime).toBe(true);
    expect(win.runtimeDir).toBeUndefined();
    // runtime dir override (WSL path) is respected and passed through
    const custom = agentRunnerConfig({ VOICECAST_RUNTIME_DIR: "/home/x/custom-rt" }, "win32");
    expect(custom.agentBin).toBe("/home/x/custom-rt/zcode");
    expect(custom.runtimeDir).toBe("/home/x/custom-rt");
  });

  it("kill-switch and env overrides (ZCODE_AGENT_BIN turns off the runtime setup)", () => {
    const off = agentRunnerConfig({ VOICECAST_AGENT_BRIDGE: "0" });
    expect(off.enabled).toBe(false);
    const cfg = agentRunnerConfig({ ZCODE_AGENT_BIN: "/x/y", ZCODE_AGENT_TIMEOUT_MS: "1000" });
    expect(cfg.agentBin).toBe("/x/y");
    expect(cfg.timeoutMs).toBe(1000);
    expect(cfg.runtime).toBe(false);
    expect(cfg.nodeBin).toBeUndefined();
  });

  it("goalSpawnArgs: direct uses argv; windows uses sh -lc with goal via ENV", () => {
    const cfg: RunnerConfig = { enabled: true, agentBin: "/home/x/zcode-agent", timeoutMs: 1, direct: true };
    const d = goalSpawnArgs(cfg, "abre um PR");
    expect(d.cmd).toBe("/home/x/zcode-agent");
    expect(d.args).toContain("-p");
    expect(d.args[d.args.indexOf("-p") + 1]).toBe("abre um PR");

    const w: RunnerConfig = { ...cfg, direct: false };
    const win = goalSpawnArgs(w, "goal com 'aspas' e $coisas");
    expect(win.cmd).toBe("wsl.exe");
    expect(win.env.VOICECAST_GOAL).toBe("goal com 'aspas' e $coisas");
    // goal never goes in the windows argv (injection/quotes)
    expect(win.args.join(" ")).not.toContain("aspas");
  });

  it("goalSpawnArgs runtime direct: spawn is the runtime's node24 + binary (never the system node)", () => {
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
    // runtime setup envs (curated data-dir) go into the spawn
    expect(d.env.ZCODE_DATA_BASE_DIR).toBe("/rt/zcode-data");
    expect(d.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe("/rt/provider/zcode-builtin.json");
  });

  it("goalSpawnArgs runtime windows: WSL script with $HOME paths, self-heal and exit 87; goal only via ENV", () => {
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
    // spawn is the runtime's node24 + the runtime's zcode (WSL paths)
    expect(script).toContain('"$RT/node24/bin/node" "$RT/zcode" --surface terminal -p "$VOICECAST_GOAL"');
    // credentials self-heal runs inside WSL via node24 -e
    expect(script).toContain('-e "$VOICECAST_SETUP_JS"');
    expect(win.env.VOICECAST_SETUP_JS).toBe(SETUP_CREDENTIALS_JS);
    // missing prerequisite → distinct exit code (87)
    expect(script).toContain("exit 87");
    // goal never goes in argv (only via ENV) and no Windows path appears
    expect(win.args.join(" ")).not.toContain("aspas");
    expect(JSON.stringify(win.args)).not.toMatch(/[A-Za-z]:\\\\/);
    // runtime dir override is passed through
    const win2 = goalSpawnArgs({ ...cfg, runtimeDir: "/home/x/custom-rt" }, "g");
    expect(win2.env.VOICECAST_RUNTIME_DIR).toBe("/home/x/custom-rt");
  });

  // W2b item 1: the goal runs in req.cwd on BOTH paths (WSL/Windows parity).
  it("W2b goalSpawnArgs windows: cwd resolved to WSL goes via ENV (never argv) and the script does cd", () => {
    const cfg: RunnerConfig = {
      enabled: true,
      agentBin: "$HOME/.local/state/voicecast/zcode-runtime/zcode",
      nodeBin: "$HOME/.local/state/voicecast/zcode-runtime/node24/bin/node",
      runtime: true,
      timeoutMs: 1,
      direct: false,
    };
    // runtime mode: Windows path becomes /mnt/c/... in the ENV
    const winRt = goalSpawnArgs(cfg, "g", undefined, "C:\\Users\\pedro\\Meu Proj");
    expect(winRt.env.VOICECAST_CWD).toBe("/mnt/c/Users/pedro/Meu Proj");
    const scriptRt = winRt.args[winRt.args.indexOf("-lc") + 1];
    expect(scriptRt.startsWith('if [ -n "$VOICECAST_CWD" ]; then cd "$VOICECAST_CWD"')).toBe(true);
    expect(scriptRt).toContain("exit 86"); // cd failed → exit distinct from 87
    // legacy mode (override): same contract
    const legacy: RunnerConfig = { enabled: true, agentBin: "/x/agent", timeoutMs: 1, direct: false };
    const winLegacy = goalSpawnArgs(legacy, "g", undefined, "C:\\Users\\pedro\\proj");
    expect(winLegacy.env.VOICECAST_CWD).toBe("/mnt/c/Users/pedro/proj");
    // path never interpolated in wsl.exe's argv (only the ENV placeholder in the script)
    expect(winRt.args.join(" ")).not.toContain("/mnt/c");
    expect(winRt.args.join(" ")).not.toMatch(/[A-Za-z]:\\\\/);
    // no cwd → no ENV (script skips cd via the -n guard)
    const noCwd = goalSpawnArgs(cfg, "g");
    expect(noCwd.env.VOICECAST_CWD).toBeUndefined();
    // direct path: cwd is the spawn's (runGoal), not the ENV's
    const direct: RunnerConfig = { enabled: true, agentBin: "/x/agent", timeoutMs: 1, direct: true };
    expect(goalSpawnArgs(direct, "g", undefined, "/home/x/proj").env.VOICECAST_CWD).toBeUndefined();
  });
});

const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe("runGoal (fake agent)", () => {
  let bin: string;
  let cfg: RunnerConfig;

  beforeAll(() => {
    bin = path.join(import.meta.dirname, "fixtures", "fake-agent.sh");
    execFileSync("chmod", ["+x", bin]);
    cfg = { enabled: true, agentBin: bin, timeoutMs: 10_000, direct: true };
  });

  it("collects stdout/stderr and exit 0 → completed", async () => {
    const r = await runGoal(
      { id: "1", goal: "teste", cwd: os.tmpdir() },
      { ...cfg, agentBin: bin },
    );
    expect(r.phase).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok do agente");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("W2b: goal runs in the requested cwd (direct/WSL path)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cwd-"));
    process.env.FAKE_PWD = "1";
    const r = await runGoal({ id: "w2b-cwd", goal: "x", cwd: dir }, cfg);
    delete process.env.FAKE_PWD;
    expect(r.phase).toBe("completed");
    expect(r.stdout).toContain(`pwd: ${dir}`);
  });

  it("exit != 0 → failed with stderr in the tail", async () => {
    setEnv("FAKE_EXIT", "3");
    const r = await runGoal({ id: "2", goal: "teste", cwd: os.tmpdir() }, cfg);
    setEnv("FAKE_EXIT", undefined);
    expect(r.phase).toBe("failed");
    expect(r.exitCode).toBe(3);
  });

  it("timeout kills the process and returns phase=timeout", async () => {
    setEnv("FAKE_SLEEP", "5");
    const r = await runGoal({ id: "3", goal: "x", cwd: os.tmpdir(), timeoutMs: 400 }, { ...cfg, timeoutMs: 400 });
    setEnv("FAKE_SLEEP", undefined);
    expect(r.phase).toBe("timeout");
    expect(r.error).toContain("timeout");
  });

  it("kill-switch returns immediate failed without spawn", async () => {
    const r = await runGoal({ id: "4", goal: "x", cwd: os.tmpdir() }, { ...cfg, enabled: false });
    expect(r.phase).toBe("failed");
    expect(r.error).toContain("VOICECAST_AGENT_BRIDGE");
  });

  it("C3: injected enrich changes the goal that reaches the agent", async () => {
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

  it("C3: broken enricher NEVER breaks the goal (fail-soft)", async () => {
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

  it("queues and runs serializing states: queued→running→completed", async () => {
    const states: string[] = [];
    const q = new GoalQueue((s) => states.push(s.phase));
    expect(q.enqueue({ id: "a", goal: "g1", cwd: os.tmpdir() }, cfg)).toEqual({ ok: true });
    q.enqueue({ id: "b", goal: "g2", cwd: os.tmpdir() }, cfg);
    expect(q.enqueue({ id: "c", goal: "  ", cwd: os.tmpdir() }, cfg)).toEqual({ ok: false, error: "empty goal" });
    await new Promise((r) => setTimeout(r, 800));
    expect(states).toContain("running");
    expect(states.filter((s) => s === "completed").length).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty goal and bridge off", () => {
    const q = new GoalQueue();
    expect(q.enqueue({ id: "x", goal: "  ", cwd: "." })).toEqual({ ok: false, error: "empty goal" });
    expect(q.enqueue({ id: "y", goal: "g", cwd: "." }, { enabled: false, agentBin: "", timeoutMs: 1, direct: true }).ok).toBe(false);
  });

  it("C3: enricher injected into the GoalQueue reaches the agent via the enriched goal", async () => {
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

// W2b item 2: ONE source for goalSummary — shared/agent-goal.ts; the runner
// only re-exports it (function identity proves there's no second implementation).
describe("goalSummary (single source)", () => {
  it("the runner's re-export IS the shared/agent-goal function", () => {
    expect(goalSummaryDoRunner).toBe(goalSummaryDaFonte);
  });
});
