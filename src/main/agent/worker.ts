/**
 * Cockpit worker (C4) — entry of the utilityProcess hosting the runner's
 * goal queue (C2/C3: runGoal/GoalQueue — THAT logic lives HERE, no
 * duplication). A worker crash doesn't take down recording/dictation (PLANO-COCKPIT
 * decision #4: bridge in a utilityProcess).
 *
 * Port protocol (src/shared/agent-worker-protocol.ts):
 * - receives {type:"enqueue", req} / {type:"status"} / {type:"enrich-result"};
 * - answers {type:"goal-state", state} on every queue transition;
 * - relays runner telemetry via {type:"telemetry", ...}.
 *
 * Telemetry (C4 decision): in the utilityProcess `require("electron")` only
 * exposes {net, systemPreferences} (measured empirically on Electron 44) —
 * there is no OTel SDK init here (NEVER duplicate init across two processes). The
 * local lazy core receives a bridge meter (setProcessMeter) that relays
 * counter/histogram to main, which re-emits them with the SAME names (a single
 * SDK/exporter — W1). Spans (withSpan of agent.goal) do NOT cross the port:
 * they are absent in the worker (accepted and documented in briefing C4).
 *
 * Enricher (C3): functions don't serialize — the worker uses a delegate that asks
 * main for the enrichment ({type:"enrich-request"}); main runs the production
 * goalContextEnricher() (goal-context.ts → library → electron,
 * unavailable in the utilityProcess). Timeout/error returns the original goal
 * (fail-soft, same C3 semantics: context is an improvement, never a dependency).
 *
 * Tests: tests/agent-worker.test.ts runs this loop with a MOCK port (the same
 * design as the W1 telemetry-worker).
 */
import { GoalQueue, type RunnerConfig } from "./runner";
import { setProcessMeter } from "../telemetry";
import type { MeterLike } from "../../shared/telemetry-core";
import type { GoalEnricher, EnrichedGoal } from "../../shared/agent-context";
import { createGoalState, type GoalState } from "../../shared/agent-goal";
import type {
  AgentWorkerInbound,
  AgentWorkerOutbound,
  AgentWorkerPort,
} from "../../shared/agent-worker-protocol";

function safePost(port: AgentWorkerPort, m: AgentWorkerOutbound): void {
  try {
    port.postMessage(m);
  } catch {}
}

/** Bridge meter: each emit becomes a {type:"telemetry"} message to main. */
function portMeter(port: AgentWorkerPort): MeterLike {
  return {
    createCounter: (name, o) => ({
      add: (n, attrs) =>
        safePost(port, { type: "telemetry", kind: "counter", name, description: o.description, n, attrs }),
    }),
    createHistogram: (name, o) => ({
      record: (n, attrs) =>
        safePost(port, { type: "telemetry", kind: "histogram", name, description: o.description, n, attrs }),
    }),
  };
}

/**
 * C3 enrichment delegate: asks main over the port and awaits the
 * matching enrich-result (correlation by rid). No response within
 * timeoutMs → resolves the ORIGINAL goal (C3 fail-soft, never blocks the queue).
 */
export function portEnricher(port: AgentWorkerPort, timeoutMs = 30_000): GoalEnricher {
  const pending = new Map<string, (r: EnrichedGoal) => void>();
  let seq = 0;
  port.on("message", (e) => {
    const m = e?.data;
    if (m?.type === "enrich-result") {
      const resolve = pending.get(m.rid);
      if (resolve) {
        pending.delete(m.rid);
        resolve(m.result);
      }
    }
  });
  return (goal) =>
    new Promise<EnrichedGoal>((resolve) => {
      const rid = `e${++seq}`;
      const timer = setTimeout(() => {
        if (pending.delete(rid)) resolve({ goal, included: false, contextChars: 0 });
      }, timeoutMs);
      timer.unref?.();
      pending.set(rid, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      safePost(port, { type: "enrich-request", rid, goal });
    });
}

export interface AgentWorkerDeps {
  /** Runner config (default: agentRunnerConfig() from the utilityProcess env). */
  cfg?: RunnerConfig;
  /** Enricher (default: delegates to main over the port — C3 in production). */
  enrich?: GoalEnricher;
  /** Delegated enrich timeout (default 30s) — no response = goal without context. */
  enrichTimeoutMs?: number;
}

/**
 * Worker loop: applies main's messages to the local GoalQueue. Each
 * state transition becomes {type:"goal-state"} over the port (the bar consumes
 * it via main broadcast). Enqueue refusals (empty goal / bridge off) become
 * a synthetic failed state — the user sees the WHY in the bar.
 */
export function runAgentWorker(port: AgentWorkerPort, deps: AgentWorkerDeps = {}): void {
  // runner/runtime-setup/context telemetry goes out over the port (SDK stays on main)
  setProcessMeter(portMeter(port));
  let lastState: GoalState | null = null;
  const onState = (s: GoalState): void => {
    lastState = s;
    safePost(port, { type: "goal-state", state: s });
  };
  const queue = new GoalQueue(onState, deps.enrich ?? portEnricher(port, deps.enrichTimeoutMs));

  port.on("message", (e) => {
    const m = e?.data as AgentWorkerInbound | undefined;
    if (!m) return;
    switch (m.type) {
      case "enqueue": {
        const r = queue.enqueue({ id: m.req.id, goal: m.req.goal, cwd: m.req.cwd }, deps.cfg);
        if (!r.ok) {
          const st: GoalState = {
            ...createGoalState(m.req.id, m.req.goal, m.req.cwd),
            phase: "failed",
            endedAt: Date.now(),
            error: r.error,
          };
          onState(st);
        }
        return;
      }
      case "status":
        safePost(port, {
          type: "status",
          state: lastState,
          size: queue.size,
          summary: queue.statusSummary(),
        });
        return;
      case "enrich-result":
        return; // consumed by the portEnricher listener
    }
  });
}

// Real entry: `utilityProcess.fork(dist/main/agent/worker.js)` lands here
// (bridge.ts resolves the path as a compiled sibling of this file). Imported
// from main/tests, process.parentPort is undefined → wires nothing.
const pp = (process as unknown as { parentPort?: AgentWorkerPort }).parentPort;
if (pp) runAgentWorker(pp);
