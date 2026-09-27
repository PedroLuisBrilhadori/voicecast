/**
 * Enriquecedor do goal com o contexto BOUNDED da última sessão (C3) — ponte
 * main entre a biblioteca e a política pura de src/shared/agent-context.ts:
 * pega a última sessão (listSessions), monta o markdown pelo `buildContext`
 * (reuso obrigatório — nunca duplicar a montagem) e aplica
 * `boundSessionContext` (inclusão + truncamento ~2k tokens).
 *
 * Fail-soft: qualquer falha (sem sessão, sem mídia, buildContext com erro,
 * exceção) devolve o goal ORIGINAL e emite o counter como "sem" — contexto é
 * melhoria, nunca dependência do goal.
 *
 * Wiring: o runner aceita o enricher INJETADO (sem import de electron lá) —
 * `new GoalQueue(onState, goalContextEnricher())` no chamador de produção
 * (C4, painel do cockpit).
 *
 * Telemetria (DoD): counter `voicecast_agent_context_total{incluido=com|sem}`;
 * `context.chars` vai como attr do span `agent.goal` (runner.ts).
 */
import { counter } from "../telemetry";
import { buildContext, getSessionDetail, listSessions } from "../library";
import {
  boundSessionContext,
  wrapSessionContextBlock,
  type EnrichedGoal,
  type GoalEnricher,
} from "../../shared/agent-context";

const M_CONTEXT = counter(
  "voicecast_agent_context_total",
  "contexto da última sessão incluído no goal (com/sem)",
);

function sem(goal: string): EnrichedGoal {
  M_CONTEXT?.add(1, { incluido: "sem" });
  return { goal, included: false, contextChars: 0 };
}

/** Enriquecedor de produção (usa a biblioteca real). Injetável p/ testes via runner. */
export function goalContextEnricher(): GoalEnricher {
  return async (goal: string): Promise<EnrichedGoal> => {
    try {
      const last = listSessions()[0];
      if (!last) return sem(goal);
      const detail = getSessionDetail(last.dir, last.name);
      if (!detail) return sem(goal);
      const ctx = await buildContext({ dir: last.dir, name: last.name });
      if ("error" in ctx || !ctx.markdown) return sem(goal);
      const bounded = boundSessionContext(detail, { markdown: ctx.markdown });
      if (!bounded) return sem(goal);
      M_CONTEXT?.add(1, { incluido: "com" });
      return {
        goal: `${goal}\n\n${wrapSessionContextBlock(bounded)}`,
        included: true,
        contextChars: bounded.length,
      };
    } catch {
      return sem(goal);
    }
  };
}
