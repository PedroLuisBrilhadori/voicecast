/**
 * Cockpit main ↔ worker protocol (C4) — PURE, no electron, testable.
 *
 * The port is utilityProcess's `process.parentPort` (Electron format:
 * `on("message", (e) => e.data)` + `postMessage`). The worker hosts the
 * runner's GoalQueue (C2/C3) and talks to main through these messages
 * (src/main/agent/worker.ts ⇄ src/main/agent/bridge.ts).
 *
 * Payloads are pure (serializable) interfaces — no functions: the C3
 * enricher does NOT cross the port (the worker delegates to main via
 * enrich-request/enrich-result, since the context library uses electron,
 * which inside utilityProcess only exposes {net, systemPreferences}).
 */
import type { GoalState } from "./agent-goal";
import type { EnrichedGoal } from "./agent-context";

export type { GoalState } from "./agent-goal";
export type { EnrichedGoal } from "./agent-context";

/** Goal request crossing the port (runGoal without enrich — functions don't serialize). */
export interface AgentGoalRequest {
  id: string;
  goal: string;
  cwd: string;
}

/** Main → worker. */
export type AgentWorkerInbound =
  | { type: "enqueue"; req: AgentGoalRequest }
  | { type: "status" }
  /** Main's response to the worker's enrich-request (C3 fail-soft: result never rejects). */
  | { type: "enrich-result"; rid: string; result: EnrichedGoal };

/** Worker → main. */
export type AgentWorkerOutbound =
  | { type: "goal-state"; state: GoalState }
  | { type: "status"; state: GoalState | null; size: number; summary: string }
  /** Worker asks main to enrich the goal (goalContextEnricher runs in main). */
  | { type: "enrich-request"; rid: string; goal: string }
  /**
   * Runner telemetry relayed to main (counter/histogram with the SAME
   * names — the OTel SDK still exists only in main's worker-thread, W1;
   * the utilityProcess does NOT duplicate the SDK init).
   */
  | {
      type: "telemetry";
      kind: "counter" | "histogram";
      name: string;
      description: string;
      n: number;
      attrs?: Record<string, string | number | boolean>;
    };

/** utilityProcess port (Electron's process.parentPort format). */
export interface AgentWorkerPort {
  on(event: "message", cb: (e: { data: AgentWorkerInbound }) => void): unknown;
  postMessage(m: AgentWorkerOutbound): void;
}
