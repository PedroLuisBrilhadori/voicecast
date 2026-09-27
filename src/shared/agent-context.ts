/**
 * Contexto BOUNDED da última sessão no goal (C3/PLANO-COCKPIT) — PURO, sem
 * electron/fs, testável. Quem chama (src/main/agent/goal-context.ts) carrega
 * a sessão e monta o markdown pelo `buildContext` (reuso obrigatório); aqui
 * vive só a DECISÃO de incluir e o TRUNCAMENTO.
 *
 * Política de inclusão (decisão do piloto C3, documentada no briefing):
 * - Jev presente: inclui se a sessão terminou há menos de `maxAgeMin`
 *   (default 30, env `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`) E
 *   `meta.jev.relevancia >= 2` (mesma política do hook C7).
 * - Jev ausente (fail-soft do julgamento — sem key/erro/off): política
 *   CONSERVADORA — só inclui se a sessão for RECENTÍSSIMA (< 5 min) E tiver
 *   transcript. Sem sinal de relevância, a recência extrema + existência de
 *   fala são os únicos proxies de que o goal se refere àquela sessão.
 * - Idade = `startedAt + durationS` (fim da sessão, como no hook C7). Idade
 *   negativa (skew de relógio no mount do Windows) é aceita (vira 0);
 *   `startedAt` ausente/inválida → exclui (não dá para provar recência).
 * - Sessão sem transcript nunca quebra: com Jev ok entra sem a seção de fala
 *   (o markdown do buildContext cita título/paths/julgamento).
 *
 * Truncamento OBRIGATÓRIO (nunca mandar transcript completo): orçamento de
 * ~2k tokens (≈ 8k chars a 4 chars/token), cortado na fronteira de
 * palavra/linha (a fronteira mais tardia dentro da janela; sem fronteira
 * razoável, corte duro no limite) com marcador explícito.
 */

export const SESSION_CONTEXT_MAX_TOKENS = 2000;
/** Aproximação chars→tokens p/ PT/EN misto (o briefing pede "~2k tokens"). */
export const CHARS_PER_TOKEN = 4;
/** Janela "recentíssima" da política conservadora sem Jev (minutos). */
export const SESSION_CONTEXT_FRESH_MIN = 5;
/** Relevância Jev mínima p/ incluir (mesma política do hook C7). */
export const SESSION_CONTEXT_MIN_RELEVANCIA = 2;
/** Default da janela de idade quando nem opts nem env definem (minutos). */
export const SESSION_CONTEXT_DEFAULT_MAX_AGE_MIN = 30;

export const SESSION_CONTEXT_BEGIN = "--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---";
export const SESSION_CONTEXT_END = "--- FIM DO CONTEXTO ---";

const TRUNCATED_MARK = "… (contexto truncado)";

/** Fatia estrutural do detail (getSessionDetail) que a decisão precisa. */
export interface BoundedContextDetail {
  meta?: {
    startedAt?: string | null;
    durationS?: number | null;
    jev?: { relevancia?: number } | null;
  } | null;
  transcript?: { text?: string } | null;
}

export interface BoundSessionContextOpts {
  /** Markdown do buildContext da sessão — sem ele não há o que incluir. */
  markdown?: string;
  /** now em ms (default Date.now()) — injeção p/ testes determinísticos. */
  now?: number;
  /** Janela de idade em min (default env VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN ou 30). */
  maxAgeMin?: number;
  /** Janela "recentíssima" sem Jev (default 5). */
  freshMaxAgeMin?: number;
  /** Orçamento em tokens (default 2000 ≈ 8k chars). */
  maxTokens?: number;
}

/** Resultado do enriquecimento do goal (contrato runner ⇄ enricher). */
export interface EnrichedGoal {
  goal: string;
  included: boolean;
  /** Tamanho do contexto bounded incluído (0 quando sem). */
  contextChars: number;
}

/** Enriquecedor injetável no runGoal/GoalQueue — produzido por goal-context.ts. */
export type GoalEnricher = (goal: string) => Promise<EnrichedGoal>;

function envMaxAgeMin(): number {
  const n = Number(process.env.VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN);
  return Number.isFinite(n) && n >= 0 ? n : SESSION_CONTEXT_DEFAULT_MAX_AGE_MIN;
}

/**
 * Idade da sessão em minutos, contada do FIM (startedAt + durationS, mesma
 * política do hook C7). Skew de relógio (idade negativa) vira 0; null quando
 * startedAt é ausente/inválida.
 */
export function sessionAgeMin(
  detail: BoundedContextDetail | null | undefined,
  now: number = Date.now(),
): number | null {
  const started = Date.parse(detail?.meta?.startedAt ?? "");
  if (!Number.isFinite(started)) return null;
  const endedMs = started + (detail?.meta?.durationS ?? 0) * 1000;
  return Math.max(0, (now - endedMs) / 60_000);
}

/**
 * Trunca no orçamento de tokens (~tokens×4 chars) na fronteira de
 * palavra/linha (a mais tardia dentro da janela; abaixo da metade da janela,
 * corte duro no limite). Texto dentro do orçamento volta intacto.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number = SESSION_CONTEXT_MAX_TOKENS,
): string {
  const maxChars = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  const at = cut >= maxChars / 2 ? cut : maxChars;
  return text.slice(0, at).trimEnd() + "\n" + TRUNCATED_MARK;
}

/** Bloco delimitado que viaja concatenado ao goal. */
export function wrapSessionContextBlock(bounded: string): string {
  return `${SESSION_CONTEXT_BEGIN}\n${bounded}\n${SESSION_CONTEXT_END}`;
}

/**
 * Decide INCLUIR (política acima) e devolve o markdown BOUNDED (truncado no
 * orçamento) — ou null quando a sessão não entra. Sem transcript não quebra;
 * sem markdown montado não há o que incluir (o caller usa buildContext).
 */
export function boundSessionContext(
  detail: BoundedContextDetail | null | undefined,
  opts: BoundSessionContextOpts = {},
): string | null {
  const now = opts.now ?? Date.now();
  const ageMin = sessionAgeMin(detail, now);
  if (ageMin == null) return null;
  const relevancia = detail?.meta?.jev?.relevancia;
  const maxAge = opts.maxAgeMin ?? envMaxAgeMin();
  const okPorJev =
    relevancia != null &&
    relevancia >= SESSION_CONTEXT_MIN_RELEVANCIA &&
    ageMin < maxAge;
  const okSemJev =
    relevancia == null &&
    !!detail?.transcript?.text &&
    ageMin < (opts.freshMaxAgeMin ?? SESSION_CONTEXT_FRESH_MIN);
  if (!okPorJev && !okSemJev) return null;
  const markdown = opts.markdown;
  if (!markdown) return null;
  return truncateToTokenBudget(markdown, opts.maxTokens ?? SESSION_CONTEXT_MAX_TOKENS);
}
