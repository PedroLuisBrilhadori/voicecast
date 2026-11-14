# C3 — Context in the goal (bounded) · blocked by C2-unlock (U1)

## Objective
Every spoken/typed goal carries the BOUNDED context of the last voicecast session
(when recent and relevant), so the agent starts knowing what you were
seeing/saying — without you pasting anything.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-COCKPIT.md` (C3 + ratified decisions)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocol)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (reuse; do NOT duplicate the markdown-assembly logic)
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` — where the
  goal is assembled/spawned (the context goes in here)
- The repo's `AGENTS.md` (rules; Telemetry section for the metrics pattern)

## Scope
**Do:**
1. `src/shared/agent-context.ts` — PURE function `boundSessionContext(detail,
   opts)`: decides whether to INCLUDE (last session < N min, default 30, and meta.jev
   relevance ≥2) and TRUNCATES at ~2k tokens (at a word/line boundary);
   testable without electron. Config via env `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`.
2. In the runner (or the GoalQueue caller): before spawning, load the
   last session via `listSessions`/`getSessionDetail` and, if the boundContext
   includes it, concatenate it to the goal in a clearly delimited block:
   `--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---\n…\n--- FIM DO CONTEXTO ---` (literal delimiter emitted by the app: "--- CONTEXT OF THE LAST SESSION (auto) --- … --- END OF CONTEXT ---").
3. Telemetry (DoD): counter `voicecast_agent_context_total{com,sem}` +
   span attr `context.chars`.

**Don't touch:** protocol/middleman (out of scope), editor UI, permission
gate (C5), bar (C4).

## Verifiable acceptance
- `pnpm ci:local` green; new `boundSessionContext` tests: includes/excludes
  by age and Jev relevance; truncates at ~2k tokens at a word boundary;
  a session without transcript doesn't break.
- Runner integration test with the fake agent (existing fixture) proving
  that the context block reaches stdin/argv per the chosen design.

## Risks and gotchas
- Context increases the goal's cost (real plan) — truncation is
  MANDATORY; never send the full transcript.
- Jev absent (fail-soft) ⇒ no relevance ⇒ include only if the session is
  ultra-recent (< 5 min)? DECIDE conservatively and document in the briefing.
- The sessions root path is Windows — `getSessionDetail` in the main process already resolves it.

## Delivery
Conventional commits, no push. Fill in the Result below.

## Result (filled in by the pilot)

**Delivered on 2026-09-27** (C3 pilot). Commits in the repo, no push:

- `6a6d751` `feat(c3): política pura do contexto bounded — boundSessionContext
  (~2k tokens, fronteira de palavra/linha)` [commit subject kept verbatim] — `src/shared/agent-context.ts`
  (new, pure — no electron/fs): `boundSessionContext(detail, opts)` decides whether to
  INCLUDE and returns the BOUNDED markdown (null = excludes); `sessionAgeMin`,
  `truncateToTokenBudget`, `wrapSessionContextBlock` and the
  `SESSION_CONTEXT_BEGIN/END` delimiters exported. The pure `EnrichedGoal`/
  `GoalEnricher` contract also lives here (the runner imports only the shared — no
  electron). + `tests/agent-context.test.ts` (18 tests).
- `cafb323` `feat(c3): contexto da última sessão no goal — enricher + counter
  + span attrs` [commit subject kept verbatim] — `src/main/agent/goal-context.ts` (new):
  `goalContextEnricher()` loads the last session (`listSessions[0]` →
  `getSessionDetail`), assembles the markdown via `buildContext` **(reuse
  mandatory — zero duplication of the assembly)** and applies the pure policy.
  `src/main/agent/runner.ts`: `RunGoalRequest.enrich?` + `GoalQueue(onState,
  enrich?)` — enrich runs BEFORE the `agent.goal` span, which is born with attrs
  `context.incluido=com|sem` and `context.chars`; a broken enricher never
  breaks the goal. Counter `voicecast_agent_context_total{incluido=com|sem}`
  (DoD) in goal-context.ts. `tests/fixtures/fake-agent.sh` gained
  `FAKE_ECHO_ARGS=1` (echoes argv — backwards compatible) and
  `tests/agent-goal-context.test.ts` (13) + 3 tests in
  `tests/agent-runner.test.ts`.

**Jev-absent policy (decision required by the briefing — conservative):**

- Jev **present**: include if age < 30 min (env
  `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`) **AND** `meta.jev.relevancia >= 2`
  (same policy as hook C7).
- Jev **absent** (fail-soft: no key/error/off): only include if the session is
  ULTRA-RECENT (< 5 min) AND has a transcript. Rationale: without a
  relevance signal, extreme recency + existence of speech are the only proxies
  that the goal refers to that session; anything older without Jev
  doesn't enter (a nearly dead feature with Jev off is the conservative price).
- Age counts from the session's **END** (`startedAt + durationS`, same as hook
  C7); clock skew (negative age on the Windows mount) is accepted (becomes
  0); missing/invalid `startedAt` → exclude (recency not provable).
- A session **without transcript doesn't break**: with Jev ok it enters without the
  speech section (markdown cites title/paths/judgment); without Jev it doesn't enter.
- Truncation **always** applied: ~2000 tokens (≈ 8k chars at 4 chars/token —
  documented approximation), cut at the word/line boundary (the latest
  within the window; hard cut below half) + marker
  `… (contexto truncado)` ["… (context truncated)" — literal marker emitted by the app]. The full transcript NEVER goes (tested).

**Integration design:** the enricher is **injected** into the runner
(`req.enrich` / `GoalQueue` constructor) — the runner still has no electron
import (runner tests intact without mock) and the production caller (C4,
panel) wires it with one line: `new GoalQueue(onState, goalContextEnricher())`.
The goal goes first, the delimited block is concatenated after
(`--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---\n…\n--- FIM DO CONTEXTO ---`).

**Evidence (verifiable acceptance):** `pnpm ci:local` green
(typecheck + **167 passed / 4 skipped** — pre-existing skips jev.smoke/
agent-live + main/preload/renderer build). The integration test proves the
required observable effect: runGoal with a real enricher (real library,
electron mocked → tmpdir) and the fake agent receiving the block in argv
(`FAKE_ECHO_ARGS`) — and the cold goal (old session) arrives without a block.

**Pending items (control tower):**
- **C4** is the production caller: pass `goalContextEnricher()` to the
  `GoalQueue` constructor (today no src code instantiates the queue).
- Human gate on Windows (`pnpm dev:win`): validate the block in a real goal and the
  counter/span reaching Grafana (dashboard uid `voicecast` can gain the
  `voicecast_agent_context_total` series — out of the pilot's scope).
- With Jev off the policy is conservative on purpose; if the maintainer
  wants an adjustable fresh window, a new env suffices (opts already support it).

Findings: no relevant neighboring bugs.
