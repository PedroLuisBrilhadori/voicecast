/**
 * Runner de goals do cockpit (C2): executa o CLI do agente ZCode em modo
 * headless (-p) no diretório do goal, coletando stdout/stderr/exit.
 *
 * - Linux/WSL (testes): spawn direto do binário configurado.
 * - Windows (produção): `wsl.exe --exec sh -lc` com o goal via ENV (nunca
 *   argv interpolado — evita quebra de aspas/injeção no shell do WSL).
 * - Fila de 1 goal por vez; timeout com kill; kill-switch VOICECAST_AGENT_BRIDGE=0.
 * - Config: ZCODE_AGENT_BIN (path do binário no WSL) e ZCODE_AGENT_TIMEOUT_MS.
 *
 * Bloqueio conhecido (2026-09-27): o CLI headless exige seleção de modelo
 * prévia ("Select a model before continuing") — ver docs/PLANO-COCKPIT.md.
 * O runner está pronto; o desbloqueio é config, não código.
 */
import { spawn } from "node:child_process";
import { counter, histogram, withSpan } from "../telemetry";
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
  /** Binário do agente DENTRO do WSL (ex.: ~/.zcode/server/agents/glm/zcode-agent). */
  agentBin: string;
  timeoutMs: number;
  /** true quando o spawn é linux direto; false = Windows via wsl.exe sh -lc. */
  direct: boolean;
}

export function agentRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const enabled = env.VOICECAST_AGENT_BRIDGE !== "0";
  return {
    enabled,
    agentBin: env.ZCODE_AGENT_BIN || "$HOME/.zcode/server/agents/glm/zcode-agent",
    timeoutMs: Number(env.ZCODE_AGENT_TIMEOUT_MS) || 15 * 60_000,
    direct: process.platform !== "win32",
  };
}

const WSL_GOAL_SH = 'exec "$VOICECAST_AGENT_BIN" --surface terminal -p "$VOICECAST_GOAL"';

/** argv do spawn (sem o goal — ele vai por env). */
export function goalSpawnArgs(cfg: RunnerConfig, goal: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (cfg.direct) {
    // exec direto: bin expandido e goal em argv (spawn não usa shell)
    const bin = cfg.agentBin.replace(/^\$HOME/, process.env.HOME ?? "~");
    return { cmd: bin, args: ["--surface", "terminal", "-p", goal], env: {} };
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
export function runGoal(req: RunGoalRequest, cfg: RunnerConfig = agentRunnerConfig()): Promise<RunGoalResult> {
  if (!cfg.enabled) {
    return Promise.resolve({ phase: "failed", exitCode: null, stdout: "", stderrTail: "", durationMs: 0, error: "bridge desligado (VOICECAST_AGENT_BRIDGE=0)" });
  }
  const t0 = Date.now();
  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  return withSpan("agent.goal", { "goal.id": req.id }, async () => {
    const { cmd, args, env } = goalSpawnArgs(cfg, req.goal);
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
