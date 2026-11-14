/**
 * Jev questions and thresholds for voicecast — single reviewable file
 * (mirror of the workspace pattern: scripts/lib/jev-questions.mjs; here the
 * texts come from the probe validated on 2026-09-21, see docs/RELATORIO-E1.md).
 *
 * Do not edit the texts without revalidating with the smoke test
 * (VOICECAST_JEV_SMOKE=1 pnpm vitest run tests/jev.smoke.test.ts).
 */

/** Possible routes for a voice entry (choice options — decidePaste depends on them). */
export const ROTAS = ["ditado_texto", "comando_agente", "anotacao_contexto", "conversa_social"] as const;
export type Rota = (typeof ROTAS)[number];

/** Above this confidence the route is executed on its own; below, pasted as dictation. */
export const AUTO_CONFIDENCE = 0.9;

/** F9 waits for the answer (before pasting): short budget, 1 attempt. */
export const JEV_TIMEOUT_DITADO_MS = 4000;
/** Session is judged in the background: generous budget. */
export const JEV_TIMEOUT_SESSAO_MS = 15000;

/** F9 dictation intent routing (choice — the quick question on the hot path). */
export const Q_ROTA = {
  type: "choice",
  instructions: "Route the user's voice input captured by voicecast.",
  criteria: {
    ditado_texto: "User wants text pasted into the focused window (pure dictation)",
    comando_agente: "User is asking for a task for the code agent to execute",
    anotacao_contexto: "Context/observation to store and associate with the session, no immediate action",
    conversa_social: "Speech directed at another person or loose thought, ignore",
  },
} as const;

/** Session judgment (one call, 3 questions in parallel). */
export const Q_RELEVANCIA = {
  type: "score",
  instructions: "Relevance of this transcript as context for the agent's next coding task.",
  criteria: [
    "Conversation unrelated to code",
    "General project context",
    "Contains a useful clue: symptom, suspicion, or module",
    "Actionable task with clear criteria",
  ],
} as const;

export const Q_PEDIDO = {
  type: "noul",
  instructions:
    "Does the transcript contain a direct request for the agent to execute a task (analyze, edit, run, answer)?",
  criteria: {
    true: "Explicit request directed at the agent/assistant",
    false: "Just conversation/observation, no request",
  },
} as const;

export const Q_RISCO = {
  type: "noul",
  instructions: "Is the requested task read-only and reversible (does not mutate code, infra, or data)?",
  criteria: {
    true: "Only read/diff/query and answer",
    false: "Involves editing, deploying, deleting, or mutating something",
  },
} as const;
