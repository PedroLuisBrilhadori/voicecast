/**
 * Cockpit goal runner (C2): executes the ZCode agent CLI in headless mode
 * (-p) in the goal directory, collecting stdout/stderr/exit.
 *
 * - C2b runtime (default, no override): uses the built CLI of the open source
 *   materialized by runtime-setup.ts (~/.local/state/voicecast/zcode-runtime)
 *   with the runtime's own node24 (the binary is an esbuild build for node 24 — never the
 *   system node) and its own auto-curated data-dir with the identity keys
 *   (U2 unlock). The setup runs once per process start (self-heal by
 *   the desktop credentials' mtime).
 * - Override (legacy): ZCODE_AGENT_BIN points to the binary directly and turns off the
 *   runtime setup — the spawn is the pure binary, as before.
 * - Linux/WSL (tests): direct spawn. Windows (production): `wsl.exe --exec
 *   /bin/sh -lc` with the goal via ENV (never interpolated argv — avoids
 *   quote breaking/injection in the WSL shell) and WSL paths ($HOME expanded inside
 *   WSL — never Windows paths); the credentials self-heal runs inside
 *   WSL via node24 -e (SETUP_CREDENTIALS_JS).
 * - W2b: the goal runs in `req.cwd` on BOTH paths — direct uses the spawn's
 *   cwd; Windows resolves the path to WSL (winPathToWsl) and passes it via ENV
 *   (VOICECAST_CWD), with `cd` in the script (never interpolated argv — same as the
 *   goal). cd failed → exit 86 (distinct from 87, the prerequisite one).
 * - Queue of 1 goal at a time; timeout with kill; kill-switch VOICECAST_AGENT_BRIDGE=0.
 * - C3: the goal can be ENRICHED with the last session's bounded context
 *   (`req.enrich`, injected by the caller — goal-context.ts; only the
 *   pure contract enters here, no electron import). The `context.*` attributes go
 *   on the `agent.goal` span.
 * - Config: ZCODE_AGENT_BIN (binary override), ZCODE_AGENT_TIMEOUT_MS,
 *   VOICECAST_ZCODE_BUILD_DIR and VOICECAST_RUNTIME_DIR (runtime setup paths).
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { counter, histogram, withSpan } from "../telemetry";
import {
  SETUP_CREDENTIALS_JS,
  defaultRuntimePaths,
  ensureRuntimeCached,
  type RuntimeSetupResult,
} from "./runtime-setup";
import {
  createGoalState,
  transitionGoal,
  type GoalPhase,
  type GoalState,
} from "../../shared/agent-goal";
import type { EnrichedGoal, GoalEnricher } from "../../shared/agent-context";
import { winPathToWsl } from "../../shared/paths";

const M_GOALS = counter("voicecast_agent_goals_total", "goals by outcome");
const H_GOAL = histogram("voicecast_agent_goal_seconds", "goal duration");

export interface RunnerConfig {
  enabled: boolean;
  /** Agent binary INSIDE WSL. Default: runtime zcode (C2b); ZCODE_AGENT_BIN overrides it. */
  agentBin: string;
  /** Runtime node 24 — when set, the spawn is `<nodeBin> <agentBin> …` (esbuild binary). */
  nodeBin?: string;
  /** true when there is NO override: runGoal runs the runtime setup before the spawn. */
  runtime?: boolean;
  /** Runtime dir override (VOICECAST_RUNTIME_DIR) — passed through to the WSL script. */
  runtimeDir?: string;
  timeoutMs: number;
  /** true when the spawn is direct linux; false = Windows via wsl.exe sh -lc. */
  direct: boolean;
}

const RUNTIME_DIR_WSL = "$HOME/.local/state/voicecast/zcode-runtime";

export function agentRunnerConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): RunnerConfig {
  const enabled = env.VOICECAST_AGENT_BRIDGE !== "0";
  const direct = platform !== "win32";
  const timeoutMs = Number(env.ZCODE_AGENT_TIMEOUT_MS) || 15 * 60_000;
  // Override (legacy): pure binary, no runtime setup.
  if (env.ZCODE_AGENT_BIN) {
    return { enabled, agentBin: env.ZCODE_AGENT_BIN, timeoutMs, direct, runtime: false };
  }
  // C2b runtime: runtime setup paths. On Windows the spawn goes through wsl.exe —
  // WSL paths ($HOME expanded inside WSL), never Windows paths.
  const runtimeDirOverride = env.VOICECAST_RUNTIME_DIR;
  const base = direct
    ? defaultRuntimePaths(env).runtimeDir
    : runtimeDirOverride || RUNTIME_DIR_WSL;
  return {
    enabled,
    agentBin: `${base}/zcode`,
    nodeBin: `${base}/node24/bin/node`,
    runtime: true,
    runtimeDir: runtimeDirOverride,
    timeoutMs,
    direct,
  };
}

/** WSL script prefix (W2b): cd into the goal directory — the path arrives via
 * ENV (VOICECAST_CWD, already resolved to WSL by the caller), never interpolated argv.
 * Empty → skips (keeps the wsl.exe default cwd); failed → distinct exit 86. */
const WSL_CD_SH =
  'if [ -n "$VOICECAST_CWD" ]; then cd "$VOICECAST_CWD" || { echo "voicecast-agent: cwd inaccessible: $VOICECAST_CWD" >&2; exit 86; }; fi; ';

const WSL_GOAL_SH =
  WSL_CD_SH + 'exec "$VOICECAST_AGENT_BIN" --surface terminal -p "$VOICECAST_GOAL"';

/**
 * Runtime mode script (Windows): ensures binaries (copies from the U1 build if
 * needed), runs the credentials self-heal inside WSL (node24 -e) and execs
 * the runtime node24. Missing prerequisite → exit 87 (distinct). Single
 * line on purpose: wsl.exe argv carries no newlines.
 */
const WSL_RUNTIME_SH =
  WSL_CD_SH +
  'RT="${VOICECAST_RUNTIME_DIR:-$HOME/.local/state/voicecast/zcode-runtime}"; ' +
  'BUILD="${VOICECAST_ZCODE_BUILD_DIR:-/tmp/zcode-cli-build}"; ' +
  'if [ ! -x "$RT/node24/bin/node" ] || [ ! -f "$RT/zcode" ]; then ' +
  'if [ ! -f "$BUILD/zcode" ] || [ ! -x "$BUILD/node24/bin/node" ]; then ' +
  'echo "voicecast-agent: agent runtime missing — materialize the U1 build (see docs/wp/U1-build-cli.md)" >&2; exit 87; fi; ' +
  'mkdir -p "$RT"; cp -a "$BUILD/zcode" "$RT/zcode" || exit 87; chmod +x "$RT/zcode"; ' +
  'rm -rf "$RT/node24"; cp -a "$BUILD/node24" "$RT/node24" || exit 87; fi; ' +
  'if [ ! -f "$RT/provider/zcode-builtin.json" ]; then ' +
  'if [ ! -f "$BUILD/provider/zcode-builtin.json" ]; then ' +
  'echo "voicecast-agent: agent runtime missing (provider config) — materialize the U1 build" >&2; exit 87; fi; ' +
  'mkdir -p "$RT/provider"; cp -a "$BUILD/provider/zcode-builtin.json" "$RT/provider/zcode-builtin.json" || exit 87; fi; ' +
  '"$RT/node24/bin/node" -e "$VOICECAST_SETUP_JS" "$HOME/.zcode/v2/credentials.json" "$RT/zcode-data" || ' +
  '{ echo "voicecast-agent: credentials sync failed" >&2; exit 87; }; ' +
  'export ZCODE_DATA_BASE_DIR="$RT/zcode-data" ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$RT/provider/zcode-builtin.json"; ' +
  '[ -f "$HOME/.zcode/v2/provider_config.json" ] && export ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json"; ' +
  'exec "$RT/node24/bin/node" "$RT/zcode" --surface terminal -p "$VOICECAST_GOAL"';

/** Spawn argv (without the goal — it goes via env). rtEnv = runtime setup envs
 * (direct mode). W2b: goal `cwd` — on the Windows path it is resolved to WSL and
 * goes via ENV (VOICECAST_CWD) for the script's `cd`; on direct, the spawn's
 * own cwd applies it (runGoal). */
export function goalSpawnArgs(
  cfg: RunnerConfig,
  goal: string,
  rtEnv?: Record<string, string>,
  cwd?: string,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const goalArgs = ["--surface", "terminal", "-p", goal];
  if (cfg.direct) {
    if (cfg.nodeBin) {
      // C2b runtime: the esbuild binary requires the runtime node24 (never the system node)
      return { cmd: cfg.nodeBin, args: [cfg.agentBin, ...goalArgs], env: { ...(rtEnv ?? {}) } };
    }
    // direct exec (override): expanded bin and goal in argv (spawn uses no shell)
    const bin = cfg.agentBin.replace(/^\$HOME/, process.env.HOME ?? "~");
    return { cmd: bin, args: goalArgs, env: {} };
  }
  // W2b: goal directory on BOTH Windows modes — path resolved to WSL
  // (winPathToWsl) and via ENV, never interpolated into the wsl.exe argv.
  const env: NodeJS.ProcessEnv = cwd ? { VOICECAST_CWD: winPathToWsl(cwd) } : {};
  if (cfg.runtime) {
    // Windows + runtime: script resolves WSL paths ($HOME) and runs the self-heal inside WSL
    env.VOICECAST_GOAL = goal;
    env.VOICECAST_SETUP_JS = SETUP_CREDENTIALS_JS;
    if (cfg.runtimeDir) env.VOICECAST_RUNTIME_DIR = cfg.runtimeDir;
    return { cmd: "wsl.exe", args: ["--exec", "/bin/sh", "-lc", WSL_RUNTIME_SH], env };
  }
  env.VOICECAST_AGENT_BIN = cfg.agentBin;
  env.VOICECAST_GOAL = goal;
  return {
    cmd: "wsl.exe",
    args: ["--exec", "/bin/sh", "-lc", WSL_GOAL_SH],
    env,
  };
}

export interface RunGoalRequest {
  id: string;
  goal: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * C3: optional goal enricher (last session's bounded context —
   * produced by goal-context.ts; injected by the caller). An enricher failure NEVER
   * breaks the goal (fail-soft, context.* attrs = without).
   */
  enrich?: GoalEnricher;
}

export interface RunGoalResult {
  phase: Extract<GoalPhase, "completed" | "failed" | "timeout" | "cancelled">;
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  durationMs: number;
  error?: string;
}

/** Runs a goal (no queue — orchestration uses GoalQueue). */
export async function runGoal(req: RunGoalRequest, cfg: RunnerConfig = agentRunnerConfig()): Promise<RunGoalResult> {
  if (!cfg.enabled) {
    return { phase: "failed", exitCode: null, stdout: "", stderrTail: "", durationMs: 0, error: "bridge off (VOICECAST_AGENT_BRIDGE=0)" };
  }
  const t0 = Date.now();
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  // C3: enrichment BEFORE the span — the context.* attrs enter the start of
  // agent.goal. A broken enricher doesn't break the goal (fail-soft, "sem").
  let goalFinal = req.goal;
  let ctxAttrs: Record<string, string | number> = {};
  if (req.enrich) {
    try {
      const eg: EnrichedGoal = await req.enrich(req.goal);
      goalFinal = eg.goal;
      ctxAttrs = {
        "context.incluido": eg.included ? "com" : "sem",
        "context.chars": eg.contextChars,
      };
    } catch {
      ctxAttrs = { "context.incluido": "sem", "context.chars": 0 };
    }
  }
  return withSpan("agent.goal", { "goal.id": req.id, ...ctxAttrs }, async () => {
    // Runtime setup (C2b): materializes/curates the data-dir once per process —
    // a prerequisite failure (no U1 build / no login) becomes a failed goal with
    // a clear error (the setup counter was already emitted at ensure).
    let rt: RuntimeSetupResult | null = null;
    if (cfg.runtime) {
      try {
        rt = await ensureRuntimeCached();
      } catch (e) {
        const result: RunGoalResult = {
          phase: "failed",
          exitCode: null,
          stdout: "",
          stderrTail: "",
          durationMs: Date.now() - t0,
          error: `runtime setup: ${(e as Error)?.message ?? e}`,
        };
        H_GOAL?.record(result.durationMs / 1000, { desfecho: result.phase });
        M_GOALS?.add(1, { desfecho: result.phase });
        return result;
      }
    }
    const { cmd, args, env } = goalSpawnArgs(cfg, goalFinal, rt?.env, req.cwd);
    const child = spawn(cmd, args, {
      cwd: cfg.direct ? req.cwd : undefined,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout = (stdout + d).slice(-64_000);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-8_000);
    });
    const result = await new Promise<RunGoalResult>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
        resolve({ phase: "timeout", exitCode: null, stdout, stderrTail: stderr.slice(-4000), durationMs: Date.now() - t0, error: `timeout ${timeoutMs}ms` });
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ phase: "failed", exitCode: null, stdout, stderrTail: stderr.slice(-4000), durationMs: Date.now() - t0, error: String(e) });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ phase: code === 0 ? "completed" : "failed", exitCode: code, stdout, stderrTail: stderr.slice(-4000), durationMs: Date.now() - t0 });
      });
    });
    H_GOAL?.record(result.durationMs / 1000, { desfecho: result.phase });
    M_GOALS?.add(1, { desfecho: result.phase });
    return result;
  });
}

// W2b: single source of the goal summary — shared/agent-goal.ts (the copy that
// lived here is gone). Re-export kept for whoever imports from the runner.
export { goalSummary } from "../../shared/agent-goal";

export class GoalQueue {
  private busy = false;
  private pending: RunGoalRequest[] = [];
  private onState: (state: GoalState) => void;
  /** C3: goal enricher (last session's context) — injected by the caller. */
  private enrich?: GoalEnricher;

  constructor(onState: (state: GoalState) => void = () => {}, enrich?: GoalEnricher) {
    this.onState = onState;
    this.enrich = enrich;
  }

  get size(): number {
    return this.pending.length + (this.busy ? 1 : 0);
  }

  /** Enqueues a goal; invalid/disabled returns an error without enqueueing. */
  enqueue(req: RunGoalRequest, cfg: RunnerConfig = agentRunnerConfig()): { ok: true } | { ok: false; error: string } {
    if (!cfg.enabled) return { ok: false, error: "bridge off (VOICECAST_AGENT_BRIDGE=0)" };
    if (!req.goal.trim()) return { ok: false, error: "empty goal" };
    this.pending.push(req);
    void this.drain(cfg);
    return { ok: true };
  }

  private async drain(cfg: RunnerConfig): Promise<void> {
    if (this.busy) return;
    const req = this.pending.shift();
    if (!req) return;
    this.busy = true;
    let state = createGoalState(req.id, req.goal, req.cwd);
    this.onState(state);
    state = transitionGoal(state, { type: "start" });
    this.onState(state);
    const result = await runGoal(this.enrich ? { ...req, enrich: this.enrich } : req, cfg);
    state = transitionGoal(state, {
      type: "finish",
      phase: result.phase === "completed" ? "completed" : result.phase === "timeout" ? "timeout" : "failed",
      error: result.error ?? (result.phase !== "completed" ? result.stderrTail.split("\n").slice(-3).join(" ").slice(0, 300) : undefined),
    });
    state = { ...state, lastOutput: result.stdout.slice(-4000) || state.lastOutput };
    this.onState(state);
    this.busy = false;
    if (this.pending.length) void this.drain(cfg);
  }

  /** Queue summary for the bar ("2 queued · running 12s"). */
  statusSummary(): string {
    if (!this.busy && !this.pending.length) return "no goals";
    const parts: string[] = [];
    if (this.pending.length) parts.push(`${this.pending.length} queued`);
    return parts.join(" · ") || "goal in progress";
  }
}
