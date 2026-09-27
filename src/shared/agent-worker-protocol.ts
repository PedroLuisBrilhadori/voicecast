/**
 * Protocolo main ↔ worker do cockpit (C4) — PURO, sem electron, testável.
 *
 * A porta é o `process.parentPort` do utilityProcess (formato Electron:
 * `on("message", (e) => e.data)` + `postMessage`). O worker hospeda o
 * GoalQueue do runner (C2/C3) e conversa com o main por estas mensagens
 * (src/main/agent/worker.ts ⇄ src/main/agent/bridge.ts).
 *
 * Payloads são interfaces puras (serializáveis) — nada de funções: o
 * enriquecedor do C3 NÃO atravessa a porta (o worker delega ao main via
 * enrich-request/enrich-result, pois a biblioteca de contexto usa electron,
 * que no utilityProcess só expõe {net, systemPreferences}).
 */
import type { GoalState } from "./agent-goal";
import type { EnrichedGoal } from "./agent-context";

export type { GoalState } from "./agent-goal";
export type { EnrichedGoal } from "./agent-context";

/** Pedido de goal que cruza a porta (runGoal sem o enrich — função não serializa). */
export interface AgentGoalRequest {
  id: string;
  goal: string;
  cwd: string;
}

/** Main → worker. */
export type AgentWorkerInbound =
  | { type: "enqueue"; req: AgentGoalRequest }
  | { type: "status" }
  /** Resposta do main ao enrich-request do worker (C3 fail-soft: result nunca rejeita). */
  | { type: "enrich-result"; rid: string; result: EnrichedGoal };

/** Worker → main. */
export type AgentWorkerOutbound =
  | { type: "goal-state"; state: GoalState }
  | { type: "status"; state: GoalState | null; size: number; summary: string }
  /** Worker pede ao main o enriquecimento do goal (goalContextEnricher roda no main). */
  | { type: "enrich-request"; rid: string; goal: string }
  /**
   * Telemetria do runner retransmitida ao main (counter/histogram com os
   * MESMOS nomes — o SDK OTel continua existindo só no worker-thread do main,
   * W1; o utilityProcess NÃO duplica init do SDK).
   */
  | {
      type: "telemetry";
      kind: "counter" | "histogram";
      name: string;
      description: string;
      n: number;
      attrs?: Record<string, string | number | boolean>;
    };

/** Porta do utilityProcess (formato do process.parentPort do Electron). */
export interface AgentWorkerPort {
  on(event: "message", cb: (e: { data: AgentWorkerInbound }) => void): unknown;
  postMessage(m: AgentWorkerOutbound): void;
}
