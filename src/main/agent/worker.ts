/**
 * Worker do cockpit (C4) — entry do utilityProcess que hospeda a fila de
 * goals do runner (C2/C3: runGoal/GoalQueue — ESSA lógica mora AQUI, sem
 * duplicação). Crash do worker não derruba gravação/ditado (decisão #4 do
 * PLANO-COCKPIT: bridge em utilityProcess).
 *
 * Protocolo pela porta (src/shared/agent-worker-protocol.ts):
 * - recebe {type:"enqueue", req} / {type:"status"} / {type:"enrich-result"};
 * - responde {type:"goal-state", state} a cada transição da fila;
 * - retransmite a telemetria do runner via {type:"telemetry", ...}.
 *
 * Telemetria (decisão C4): no utilityProcess o `require("electron")` só
 * expõe {net, systemPreferences} (medido empiricamente no Electron 44) —
 * não há init do SDK OTel aqui (NUNCA duplicar init em dois processos). O
 * core lazy local recebe um meter-ponte (setProcessMeter) que retransmite
 * counter/histogram ao main, que os reemite com os MESMOS nomes (um único
 * SDK/exporter — W1). Spans (withSpan do agent.goal) NÃO atravessam a porta:
 * ficam ausentes no worker (aceito e documentado no briefing C4).
 *
 * Enricher (C3): função não serializa — o worker usa um delegante que pede
 * o enriquecimento ao main ({type:"enrich-request"}); o main roda o
 * goalContextEnricher() de produção (goal-context.ts → biblioteca → electron,
 * indisponível no utilityProcess). Timeout/erro devolve o goal original
 * (fail-soft, mesma semântica do C3: contexto é melhoria, nunca dependência).
 *
 * Testes: tests/agent-worker.test.ts roda este loop com porta MOCK (o mesmo
 * desenho do telemetry-worker do W1).
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

/** Meter-ponte: cada emit vira mensagem {type:"telemetry"} ao main. */
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
 * Delegante do enriquecimento C3: pede ao main pela porta e aguarda o
 * enrich-result correspondente (correlação por rid). Sem resposta em
 * timeoutMs → resolve o goal ORIGINAL (fail-soft do C3, nunca trava a fila).
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
  /** Config do runner (default: agentRunnerConfig() do env do utilityProcess). */
  cfg?: RunnerConfig;
  /** Enriquecedor (default: delega ao main pela porta — C3 em produção). */
  enrich?: GoalEnricher;
  /** Timeout do enrich delegado (default 30s) — sem resposta = goal sem contexto. */
  enrichTimeoutMs?: number;
}

/**
 * Loop do worker: aplica as mensagens do main ao GoalQueue local. Cada
 * transição de estado vira {type:"goal-state"} pela porta (a barra consome
 * via broadcast do main). Recusas de enqueue (goal vazio / bridge off) viram
 * um estado sintético failed — o usuário vê o POR QUÊ na barra.
 */
export function runAgentWorker(port: AgentWorkerPort, deps: AgentWorkerDeps = {}): void {
  // telemetria do runner/runtime-setup/context sai pela porta (SDK continua no main)
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
        return; // consumido pelo listener do portEnricher
    }
  });
}

// Entrada real: `utilityProcess.fork(dist/main/agent/worker.js)` cai aqui
// (bridge.ts resolve o path como sibling compilado deste arquivo). Importado
// no main/testes, process.parentPort é undefined → não liga nada.
const pp = (process as unknown as { parentPort?: AgentWorkerPort }).parentPort;
if (pp) runAgentWorker(pp);
