/**
 * Pure cockpit goal-cycle logic (C2/PLANO-COCKPIT) — no electron, testable.
 * The runner (main/agent/runner.ts) uses this state to emit updates to the
 * bar and persist the outcome.
 */

export type GoalPhase =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

/** Terminal phase? */
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
  /** Last agent text (for the bar/overlay to display). */
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

/** Single valid transition — out-of-phase events are ignored (fail-soft). */
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

/** Readable outcome for the bar (and for meta.json.agentGoals). */
export function goalSummary(state: GoalState): string {
  switch (state.phase) {
    case "queued":
      return "goal queued";
    case "running":
      return `running · ${Math.round((Date.now() - (state.startedAt ?? Date.now())) / 1000)}s`;
    case "completed":
      return "goal completed";
    case "timeout":
      return "goal timed out";
    case "cancelled":
      return "goal cancelled";
    case "failed":
      return `goal failed: ${state.error ?? "unknown error"}`;
  }
}
