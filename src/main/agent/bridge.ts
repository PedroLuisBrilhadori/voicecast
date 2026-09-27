/**
 * Ponte main ↔ worker do cockpit (C4): utilityProcess.fork do worker
 * (dist/main/agent/worker.js — sibling compilado deste arquivo pelo tsc),
 * relay de mensagens e cleanup no quit.
 *
 * - Isolamento de crash (decisão #4 ratificada do PLANO-COCKPIT): queda do
 *   worker não derruba gravação/ditado — o fork é refeito lazy no próximo
 *   enqueue.
 * - Kill-switch DUPLO: VOICECAST_AGENT_BRIDGE=0 impede o fork AQUI (nível da
 *   ponte) e o runner dentro do worker também recusa (agentRunnerConfig).
 * - Enricher (C3): roda NO MAIN (goalContextEnricher() → biblioteca →
 *   electron) e responde os enrich-request do worker pela porta — no
 *   utilityProcess o electron não expõe `app` (medido: só
 *   {net, systemPreferences} no Electron 44).
 * - Telemetria: counter voicecast_agent_bridge_messages_total{direcao} conta
 *   cada mensagem main→worker / worker→main; mensagens {type:"telemetry"} do
 *   worker são reemitidas na telemetria DO MAIN (um único SDK/exporter — W1).
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
  "mensagens da ponte main↔worker do cockpit (utilityProcess) por direção",
);

export interface AgentBridge {
  /** Enfileira um goal no worker (gera id; cwd default = home do usuário). */
  enqueue(goal: string): { ok: true; id: string } | { ok: false; error: string };
  /** Último GoalState recebido do worker — snapshot p/ agentGetState. */
  lastState(): GoalState | null;
  /** Encerra o utilityProcess (app will-quit). */
  stop(): void;
}

export function createAgentBridge(onState: (s: GoalState) => void): AgentBridge {
  const enrich = goalContextEnricher(); // C3 em produção — roda no main
  let child: UtilityProcess | null = null;
  let last: GoalState | null = null;
  let stopped = false;
  let seq = 0;

  const enabled = (): boolean => process.env.VOICECAST_AGENT_BRIDGE !== "0";

  const fork = (): UtilityProcess | null => {
    if (stopped) return null;
    const file = path.join(__dirname, "worker.js");
    if (!fs.existsSync(file)) {
      logError("agent-bridge: worker não encontrado (build ausente?):", file);
      return null;
    }
    const c = utilityProcess.fork(file, [], {
      serviceName: "voicecast-agent-worker",
      env: { ...process.env }, // runner resolve config pelo env do utilityProcess
    });
    c.on("message", (m: AgentWorkerOutbound) => {
      M_BRIDGE?.add(1, { direcao: "worker-main" });
      switch (m.type) {
        case "goal-state":
          last = m.state;
          onState(m.state);
          return;
        case "enrich-request":
          // C3 no main: buildContext/biblioteca precisam de electron (app)
          void enrich(m.goal)
            .catch(() => ({ goal: m.goal, included: false, contextChars: 0 }) as const)
            .then((result) => post({ type: "enrich-result", rid: m.rid, result }));
          return;
        case "telemetry":
          // reemite na telemetria do main — nomes Prometheus preservados
          if (m.kind === "counter") counter(m.name, m.description).add(m.n, m.attrs);
          else histogram(m.name, m.description).record(m.n, m.attrs);
          return;
        case "status":
          if (m.state) last = m.state;
          return;
      }
    });
    c.on("exit", (code) => {
      if (!stopped) logError(`agent-bridge: worker saiu (code=${code}) — refork lazy no próximo enqueue`);
      child = null;
    });
    logInfo("agent-bridge: utilityProcess do worker subiu (", file, ")");
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
      logError("agent-bridge: postMessage falhou:", e);
      return false;
    }
  };

  return {
    enqueue(goal: string) {
      if (!enabled()) return { ok: false as const, error: "bridge desligado (VOICECAST_AGENT_BRIDGE=0)" };
      if (!goal.trim()) return { ok: false as const, error: "goal vazio" };
      const req: AgentGoalRequest = {
        id: `goal-${Date.now().toString(36)}-${++seq}`,
        goal: goal.trim(),
        // workspace default (decisão #1 do PLANO-COCKPIT: seletor por goal é
        // UI futura; v1 roda na home do usuário)
        cwd: os.homedir(),
      };
      if (!post({ type: "enqueue", req })) {
        return { ok: false as const, error: "worker do agente indisponível (fork falhou — ver logs)" };
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
