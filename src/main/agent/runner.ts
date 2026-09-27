/**
 * Runner de goals do cockpit (C2): executa o CLI do agente ZCode em modo
 * headless (-p) no diretório do goal, coletando stdout/stderr/exit.
 *
 * - Runtime C2b (default, sem override): usa o CLI buildado do open source
 *   materializado por runtime-setup.ts (~/.local/state/voicecast/zcode-runtime)
 *   com o node24 do próprio runtime (o binário é esbuild p/ node 24 — nunca o
 *   node do sistema) e o data-dir próprio auto-curado com as identity keys
 *   (desbloqueio U2). O setup roda 1x por start do processo (self-heal por
 *   mtime do credentials do desktop).
 * - Override (legado): ZCODE_AGENT_BIN aponta o binário direto e desliga o
 *   runtime setup — spawn é o binário puro, como antes.
 * - Linux/WSL (testes): spawn direto. Windows (produção): `wsl.exe --exec
 *   /bin/sh -lc` com o goal via ENV (nunca argv interpolado — evita quebra de
 *   aspas/injeção no shell do WSL) e paths WSL ($HOME expandido dentro do
 *   WSL — nunca paths Windows); o self-heal de credentials roda dentro do
 *   WSL via node24 -e (SETUP_CREDENTIALS_JS).
 * - Fila de 1 goal por vez; timeout com kill; kill-switch VOICECAST_AGENT_BRIDGE=0.
 * - Config: ZCODE_AGENT_BIN (override do binário), ZCODE_AGENT_TIMEOUT_MS,
 *   VOICECAST_ZCODE_BUILD_DIR e VOICECAST_RUNTIME_DIR (paths do runtime setup).
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

const M_GOALS = counter("voicecast_agent_goals_total", "goals por desfecho");
const H_GOAL = histogram("voicecast_agent_goal_seconds", "duração do goal");

export interface RunnerConfig {
  enabled: boolean;
  /** Binário do agente DENTRO do WSL. Default: zcode do runtime (C2b); ZCODE_AGENT_BIN sobrescreve. */
  agentBin: string;
  /** Node 24 do runtime — quando setado, o spawn é `<nodeBin> <agentBin> …` (binário esbuild). */
  nodeBin?: string;
  /** true quando NÃO há override: runGoal executa o runtime setup antes do spawn. */
  runtime?: boolean;
  /** Override do runtime dir (VOICECAST_RUNTIME_DIR) — repassado ao script WSL. */
  runtimeDir?: string;
  timeoutMs: number;
  /** true quando o spawn é linux direto; false = Windows via wsl.exe sh -lc. */
  direct: boolean;
}

const RUNTIME_DIR_WSL = "$HOME/.local/state/voicecast/zcode-runtime";

export function agentRunnerConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): RunnerConfig {
  const enabled = env.VOICECAST_AGENT_BRIDGE !== "0";
  const direct = platform !== "win32";
  const timeoutMs = Number(env.ZCODE_AGENT_TIMEOUT_MS) || 15 * 60_000;
  // Override (legado): binário puro, sem runtime setup.
  if (env.ZCODE_AGENT_BIN) {
    return { enabled, agentBin: env.ZCODE_AGENT_BIN, timeoutMs, direct, runtime: false };
  }
  // Runtime C2b: paths do runtime setup. No Windows o spawn é via wsl.exe —
  // paths WSL ($HOME expandido dentro do WSL), nunca paths Windows.
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

const WSL_GOAL_SH = 'exec "$VOICECAST_AGENT_BIN" --surface terminal -p "$VOICECAST_GOAL"';

/**
 * Script do modo runtime (Windows): garante binários (copia do build U1 se
 * preciso), roda o self-heal de credentials dentro do WSL (node24 -e) e exec
 * no node24 do runtime. Pré-requisito ausente → exit 87 (distinto). Single
 * line de propósito: argv do wsl.exe não leva newlines.
 */
const WSL_RUNTIME_SH =
  'RT="${VOICECAST_RUNTIME_DIR:-$HOME/.local/state/voicecast/zcode-runtime}"; ' +
  'BUILD="${VOICECAST_ZCODE_BUILD_DIR:-/tmp/zcode-cli-build}"; ' +
  'if [ ! -x "$RT/node24/bin/node" ] || [ ! -f "$RT/zcode" ]; then ' +
  'if [ ! -f "$BUILD/zcode" ] || [ ! -x "$BUILD/node24/bin/node" ]; then ' +
  'echo "voicecast-agent: runtime do agente ausente — materialize o build do U1 (ver docs/wp/U1-build-cli.md)" >&2; exit 87; fi; ' +
  'mkdir -p "$RT"; cp -a "$BUILD/zcode" "$RT/zcode" || exit 87; chmod +x "$RT/zcode"; ' +
  'rm -rf "$RT/node24"; cp -a "$BUILD/node24" "$RT/node24" || exit 87; fi; ' +
  'if [ ! -f "$RT/provider/zcode-builtin.json" ]; then ' +
  'if [ ! -f "$BUILD/provider/zcode-builtin.json" ]; then ' +
  'echo "voicecast-agent: runtime do agente ausente (provider config) — materialize o build do U1" >&2; exit 87; fi; ' +
  'mkdir -p "$RT/provider"; cp -a "$BUILD/provider/zcode-builtin.json" "$RT/provider/zcode-builtin.json" || exit 87; fi; ' +
  '"$RT/node24/bin/node" -e "$VOICECAST_SETUP_JS" "$HOME/.zcode/v2/credentials.json" "$RT/zcode-data" || ' +
  '{ echo "voicecast-agent: sincronizacao de credentials falhou" >&2; exit 87; }; ' +
  'export ZCODE_DATA_BASE_DIR="$RT/zcode-data" ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$RT/provider/zcode-builtin.json"; ' +
  '[ -f "$HOME/.zcode/v2/provider_config.json" ] && export ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json"; ' +
  'exec "$RT/node24/bin/node" "$RT/zcode" --surface terminal -p "$VOICECAST_GOAL"';

/** argv do spawn (sem o goal — ele vai por env). rtEnv = envs do runtime setup (modo direto). */
export function goalSpawnArgs(
  cfg: RunnerConfig,
  goal: string,
  rtEnv?: Record<string, string>,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const goalArgs = ["--surface", "terminal", "-p", goal];
  if (cfg.direct) {
    if (cfg.nodeBin) {
      // runtime C2b: esbuild binário exige o node24 do runtime (nunca o node do sistema)
      return { cmd: cfg.nodeBin, args: [cfg.agentBin, ...goalArgs], env: { ...(rtEnv ?? {}) } };
    }
    // exec direto (override): bin expandido e goal em argv (spawn não usa shell)
    const bin = cfg.agentBin.replace(/^\$HOME/, process.env.HOME ?? "~");
    return { cmd: bin, args: goalArgs, env: {} };
  }
  if (cfg.runtime) {
    // Windows + runtime: script resolve paths WSL ($HOME) e roda o self-heal dentro do WSL
    const env: NodeJS.ProcessEnv = { VOICECAST_GOAL: goal, VOICECAST_SETUP_JS: SETUP_CREDENTIALS_JS };
    if (cfg.runtimeDir) env.VOICECAST_RUNTIME_DIR = cfg.runtimeDir;
    return { cmd: "wsl.exe", args: ["--exec", "/bin/sh", "-lc", WSL_RUNTIME_SH], env };
  }
  return {
    cmd: "wsl.exe",
    args: ["--exec", "/bin/sh", "-lc", WSL_GOAL_SH],
    env: { VOICECAST_AGENT_BIN: cfg.agentBin, VOICECAST_GOAL: goal },
  };
}

export interface RunGoalRequest {
  id: string;
  goal: string;
  cwd: string;
  timeoutMs?: number;
}

export interface RunGoalResult {
  phase: Extract<GoalPhase, "completed" | "failed" | "timeout" | "cancelled">;
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  durationMs: number;
  error?: string;
}

/** Executa um goal (sem fila — quem orquestra usa GoalQueue). */
export async function runGoal(req: RunGoalRequest, cfg: RunnerConfig = agentRunnerConfig()): Promise<RunGoalResult> {
  if (!cfg.enabled) {
    return { phase: "failed", exitCode: null, stdout: "", stderrTail: "", durationMs: 0, error: "bridge desligado (VOICECAST_AGENT_BRIDGE=0)" };
  }
  const t0 = Date.now();
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  return withSpan("agent.goal", { "goal.id": req.id }, async () => {
    // Runtime setup (C2b): materializa/cura o data-dir 1x por processo —
    // falha de pré-requisito (sem build U1 / sem login) vira goal failed com
    // erro claro (o counter de setup já foi emitido no ensure).
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
    const { cmd, args, env } = goalSpawnArgs(cfg, req.goal, rt?.env);
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

export function goalSummary(state: GoalState): string {
  switch (state.phase) {
    case "queued":
      return "goal na fila";
    case "running":
      return `rodando · ${Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000)}s`;
    case "completed":
      return "goal concluído";
    case "timeout":
      return "goal excedeu o tempo";
    case "cancelled":
      return "goal cancelado";
    case "failed":
      return `goal falhou: ${state.error ?? "erro desconhecido"}`;
  }
}
export class GoalQueue {
  private busy = false;
  private pending: RunGoalRequest[] = [];
  private onState: (state: GoalState) => void;

  constructor(onState: (state: GoalState) => void = () => {}) {
    this.onState = onState;
  }

  get size(): number {
    return this.pending.length + (this.busy ? 1 : 0);
  }

  /** Enfileira um goal; inválido/disabled devolve erro sem enfileirar. */
  enqueue(req: RunGoalRequest, cfg: RunnerConfig = agentRunnerConfig()): { ok: true } | { ok: false; error: string } {
    if (!cfg.enabled) return { ok: false, error: "bridge desligado (VOICECAST_AGENT_BRIDGE=0)" };
    if (!req.goal.trim()) return { ok: false, error: "goal vazio" };
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
    const result = await runGoal(req, cfg);
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

  /** Resumo da fila p/ barra ("2 na fila · rodando 12s"). */
  statusSummary(): string {
    if (!this.busy && !this.pending.length) return "sem goals";
    const parts: string[] = [];
    if (this.pending.length) parts.push(`${this.pending.length} na fila`);
    return parts.join(" · ") || "goal em andamento";
  }
}
