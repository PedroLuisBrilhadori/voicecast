/**
 * BOUNDED context of the last session in the goal (C3/PLANO-COCKPIT) — PURE,
 * no electron/fs, testable. The caller (src/main/agent/goal-context.ts) loads
 * the session and builds the markdown via `buildContext` (reuse mandatory);
 * only the inclusion DECISION and the TRUNCATION live here.
 *
 * Inclusion policy (C3 pilot decision, documented in the briefing):
 * - Jev present: include if the session ended less than `maxAgeMin` ago
 *   (default 30, env `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`) AND
 *   `meta.jev.relevancia >= 2` (same policy as hook C7).
 * - Jev absent (fail-soft of the judgment — no key/error/off): CONSERVATIVE
 *   policy — only includes if the session is VERY RECENT (< 5 min) AND has a
 *   transcript. Without a relevance signal, extreme recency + existence of
 *   speech are the only proxies that the goal refers to that session.
 * - Age = `startedAt + durationS` (end of session, as in hook C7). Negative
 *   age (clock skew on the Windows mount) is accepted (becomes 0);
 *   missing/invalid `startedAt` → exclude (recency cannot be proven).
 * - A session without a transcript never breaks: with Jev ok it gets in
 *   without the speech section (buildContext's markdown cites title/paths/
 *   judgment).
 *
 * MANDATORY truncation (never send the full transcript): budget of ~2k
 * tokens (≈ 8k chars at 4 chars/token), cut at a word/line boundary (the
 * latest boundary inside the window; with no reasonable boundary, hard cut
 * at the limit) with an explicit marker.
 */

export const SESSION_CONTEXT_MAX_TOKENS = 2000;
/** chars→tokens approximation for mixed PT/EN (the briefing asks for "~2k tokens"). */
export const CHARS_PER_TOKEN = 4;
/** "Very recent" window of the conservative policy without Jev (minutes). */
export const SESSION_CONTEXT_FRESH_MIN = 5;
/** Minimum Jev relevance to include (same policy as hook C7). */
export const SESSION_CONTEXT_MIN_RELEVANCIA = 2;
/** Default age window when neither opts nor env define it (minutes). */
export const SESSION_CONTEXT_DEFAULT_MAX_AGE_MIN = 30;

export const SESSION_CONTEXT_BEGIN = "--- LAST SESSION CONTEXT (auto) ---";
export const SESSION_CONTEXT_END = "--- END OF CONTEXT ---";

const TRUNCATED_MARK = "… (context truncated)";

/** Structural slice of the detail (getSessionDetail) the decision needs. */
export interface BoundedContextDetail {
  meta?: {
    startedAt?: string | null;
    durationS?: number | null;
    jev?: { relevancia?: number } | null;
  } | null;
  transcript?: { text?: string } | null;
}

export interface BoundSessionContextOpts {
  /** Session markdown from buildContext — without it there is nothing to include. */
  markdown?: string;
  /** now in ms (default Date.now()) — injection for deterministic tests. */
  now?: number;
  /** Age window in min (default env VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN or 30). */
  maxAgeMin?: number;
  /** "Very recent" window without Jev (default 5). */
  freshMaxAgeMin?: number;
  /** Token budget (default 2000 ≈ 8k chars). */
  maxTokens?: number;
}

/** Goal enrichment result (runner ⇄ enricher contract). */
export interface EnrichedGoal {
  goal: string;
  included: boolean;
  /** Size of the included bounded context (0 when none). */
  contextChars: number;
}

/** Enricher injectable into runGoal/GoalQueue — produced by goal-context.ts. */
export type GoalEnricher = (goal: string) => Promise<EnrichedGoal>;

function envMaxAgeMin(): number {
  const n = Number(process.env.VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN);
  return Number.isFinite(n) && n >= 0 ? n : SESSION_CONTEXT_DEFAULT_MAX_AGE_MIN;
}

/**
 * Session age in minutes, counted from the END (startedAt + durationS, same
 * policy as hook C7). Clock skew (negative age) becomes 0; null when
 * startedAt is missing/invalid.
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
 * Truncates to the token budget (~tokens×4 chars) at a word/line boundary
 * (the latest one within the window; below half the window, hard cut at the
 * limit). Text within the budget comes back intact.
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

/** Delimited block that travels concatenated to the goal. */
export function wrapSessionContextBlock(bounded: string): string {
  return `${SESSION_CONTEXT_BEGIN}\n${bounded}\n${SESSION_CONTEXT_END}`;
}

/**
 * Decides whether to INCLUDE (policy above) and returns the BOUNDED markdown
 * (truncated to budget) — or null when the session doesn't make it. Without
 * a transcript it doesn't break; without built markdown there is nothing to
 * include (the caller uses buildContext).
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
