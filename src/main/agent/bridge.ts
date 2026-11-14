/**
 * Cockpit main ↔ worker bridge (C4): utilityProcess.fork of the worker
 * (dist/main/agent/worker.js — compiled sibling of this file by tsc),
 * message relay and cleanup on quit.
 *
 * - Crash isolation (ratified decision #4 of PLANO-COCKPIT): a worker crash
 *   doesn't take down recording/dictation — the fork is redone lazily on the next
 *   enqueue.
 * - DOUBLE kill-switch: VOICECAST_AGENT_BRIDGE=0 prevents the fork HERE (bridge
 *   level) and the runner inside the worker also refuses (agentRunnerConfig).
 * - Enricher (C3): runs ON MAIN (goalContextEnricher() → library →
 *   electron) and answers the worker's enrich-requests over the port — in the
 *   utilityProcess electron doesn't expose `app` (measured: only
 *   {net, systemPreferences} on Electron 44).
 * - Telemetry: counter voicecast_agent_bridge_messages_total{direcao} counts
 *   each main→worker / worker→main message; worker {type:"telemetry"} messages are
 *   re-emitted in MAIN telemetry (a single SDK/exporter — W1).
 */
import { utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { counter, histogram } from "../telemetry";
import { logError, logInfo } from "../logging";
import { goalContextEnricher } from "./goal-context";
import type { GoalState } from "../../shared/agent-goal";
import type {
  AgentGoalRequest,
  AgentWorkerInbound,
  AgentWorkerOutbound,
} from "../../shared/agent-worker-protocol";

const M_BRIDGE = counter(
  "voicecast_agent_bridge_messages_total",
  "cockpit main↔worker bridge (utilityProcess) messages by direction",
);

export interface AgentBridge {
  /** Enqueues a goal in the worker (generates id; default cwd = user home). */
  enqueue(goal: string): { ok: true; id: string } | { ok: false; error: string };
  /** Last GoalState received from the worker — snapshot for agentGetState. */
  lastState(): GoalState | null;
  /** Shuts down the utilityProcess (app will-quit). */
  stop(): void;
}

export function createAgentBridge(onState: (s: GoalState) => void): AgentBridge {
  const enrich = goalContextEnricher(); // C3 in production — runs on main
  let child: UtilityProcess | null = null;
  let last: GoalState | null = null;
  let stopped = false;
  let seq = 0;

  const enabled = (): boolean => process.env.VOICECAST_AGENT_BRIDGE !== "0";

  const fork = (): UtilityProcess | null => {
    if (stopped) return null;
    const file = path.join(__dirname, "worker.js");
    if (!fs.existsSync(file)) {
      logError("agent-bridge: worker not found (missing build?):", file);
      return null;
    }
    const c = utilityProcess.fork(file, [], {
      serviceName: "voicecast-agent-worker",
      env: { ...process.env }, // runner resolves config from the utilityProcess env
    });
    c.on("message", (m: AgentWorkerOutbound) => {
      M_BRIDGE?.add(1, { direcao: "worker-main" });
      switch (m.type) {
        case "goal-state":
          last = m.state;
          onState(m.state);
          return;
        case "enrich-request":
          // C3 on main: buildContext/library need electron (app)
          void enrich(m.goal)
            .catch(() => ({ goal: m.goal, included: false, contextChars: 0 }) as const)
            .then((result) => post({ type: "enrich-result", rid: m.rid, result }));
          return;
        case "telemetry":
          // re-emits into main telemetry — Prometheus names preserved
          if (m.kind === "counter") counter(m.name, m.description).add(m.n, m.attrs);
          else histogram(m.name, m.description).record(m.n, m.attrs);
          return;
        case "status":
          if (m.state) last = m.state;
          return;
      }
    });
    c.on("exit", (code) => {
      if (!stopped) logError(`agent-bridge: worker exited (code=${code}) — lazy refork on next enqueue`);
      child = null;
    });
    logInfo("agent-bridge: worker utilityProcess up (", file, ")");
    return c;
  };

  const post = (m: AgentWorkerInbound): boolean => {
    if (!child) child = fork();
    if (!child) return false;
    M_BRIDGE?.add(1, { direcao: "main-worker" });
    try {
      child.postMessage(m);
      return true;
    } catch (e) {
      logError("agent-bridge: postMessage failed:", e);
      return false;
    }
  };

  return {
    enqueue(goal: string) {
      if (!enabled()) return { ok: false as const, error: "bridge off (VOICECAST_AGENT_BRIDGE=0)" };
      if (!goal.trim()) return { ok: false as const, error: "empty goal" };
      const req: AgentGoalRequest = {
        id: `goal-${Date.now().toString(36)}-${++seq}`,
        goal: goal.trim(),
        // default workspace (PLANO-COCKPIT decision #1: per-goal selector is
        // future UI; v1 runs in the user home)
        cwd: os.homedir(),
      };
      if (!post({ type: "enqueue", req })) {
        return { ok: false as const, error: "agent worker unavailable (fork failed — see logs)" };
      }
      return { ok: true as const, id: req.id };
    },
    lastState: () => last,
    stop: () => {
      stopped = true;
      if (child) {
        child.kill();
        child = null;
      }
    },
  };
}
