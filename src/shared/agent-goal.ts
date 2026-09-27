/**
 * Lógica pura do ciclo de goal do cockpit (C2/PLANO-COCKPIT) — sem electron,
 * testável. O runner (main/agent/runner.ts) usa este estado para emitir
 * atualizações à barra e persistir o desfecho.
 */

export type GoalPhase =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

/** Fase terminal? */
export function isGoalFinal(phase: GoalPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "timeout" || phase === "cancelled";
}

export interface GoalState {
  id: string;
  goal: string;
  cwd: string;
  phase: GoalPhase;
  startedAt: number | null;
  endedAt: number | null;
  /** Último texto do agente (para a barra/overlay mostrarem). */
  lastOutput: string | null;
  error: string | null;
}

export type GoalEvent =
  | { type: "start" }
  | { type: "output"; text: string }
  | { type: "finish"; phase: "completed" | "failed" | "timeout"; error?: string }
  | { type: "cancel" };

export function createGoalState(id: string, goal: string, cwd: string): GoalState {
  return { id, goal, cwd, phase: "queued", startedAt: null, endedAt: null, lastOutput: null, error: null };
}

/** Transição única e válida — evento fora de fase é ignorado (fail-soft). */
export function transitionGoal(state: GoalState, ev: GoalEvent): GoalState {
  switch (ev.type) {
    case "start":
      if (state.phase !== "queued") return state;
      return { ...state, phase: "running", startedAt: Date.now() };
    case "output":
      if (state.phase !== "running") return state;
      return { ...state, lastOutput: ev.text.slice(-4000) };
    case "finish":
      if (state.phase !== "running") return state;
      return { ...state, phase: ev.phase, endedAt: Date.now(), error: ev.error ?? null };
    case "cancel":
      if (isGoalFinal(state.phase)) return state;
      return { ...state, phase: "cancelled", endedAt: Date.now() };
  }
}

/** Desfecho legível para a barra (e para meta.json.agentGoals). */
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
