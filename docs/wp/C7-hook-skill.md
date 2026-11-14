# C7 — UserPromptSubmit hook + voicecast skill in ZCode · done (human gate)

## Objective
When the maintainer works INSIDE ZCode, the last voicecast session's
context arrives on its own: the `UserPromptSubmit` hook injects a bounded
digest (Jev relevance ≥2) and a skill teaches the agent to consume the artifacts.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/docs/PLAN-COCKPIT.md` (item C7)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGATION.md` (protocol)
- `/home/pedro/programing/projetos/zcode.json` (workspace) — how house hooks
  are registered (follow the pattern of the existing hooks; EVERY new hook enters
  this file with `enabled: false` until the human gate)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (the digest is a BOUNDED version of it: ~500 tokens)
- voicecast sessions on disk (via WSL): layout in voicecast's `AGENTS.md`;
  root `%LOCALAPPDATA%\voicecast\sessions` = `/mnt/c/Users/pedro/AppData/Local/voicecast/sessions`

## Scope
**Do:**
1. Script `scripts/lib/voicecast-context-digest.mjs` IN THE WORKSPACE ROOT
   (house hooks pattern: pure node, no deps): reads the last session
   (< N min, default 30, env `VOICECAST_DIGEST_MAX_AGE_MIN`), assembles a
   bounded digest (title, duration, transcript if Jev relevance ≥2, WSL paths of
   artifacts), prints to stdout as a markdown block. No recent session:
   exits silently (exit 0, no output).
2. Registration of the `UserPromptSubmit` hook in `/home/pedro/programing/projetos/zcode.json`
   with `"enabled": false` (the maintainer turns it on at the gate).
3. `.zcode/skills/voicecast/SKILL.md` skill in the workspace: when/how to ask for
   voicecast context, artifact contract (PNG screenshots ≤30MB, MP4 clips,
   transcript with timestamps — F0 rule).
4. Telemetry (DoD): usage JSONL in the guardrails pattern
   (`~/.local/state/voicecast-digest.log` — one line per injection).

**Don't touch:** voicecast repo src/ (only docs if needed), any other hook,
any `enabled: true`.

## Verifiable acceptance
- `node scripts/lib/voicecast-context-digest.mjs` with a fake session in a
  temporary directory (env `VOICECAST_SESSIONS_ROOT` for tests) prints the
  expected digest; without a session, silence; age > N, silence.
- Root `node --test scripts/*.test.mjs` tests stay green + new
  digest test (fixtures in scripts/lib/__tests__/).
- Skill exists and references correct paths.

## Risks and gotchas
- zcode.json is the maintainer's harness config — MINIMAL CHANGE (only the new
  block, enabled false). Any format doubt: copy the pattern of an existing
  hook in the same file.
- Never log transcript content in the telemetry JSONL (metadata only).

## Delivery
Conventional commits in BOTH repos (root: hook+skill; voicecast: nothing or
docs). No push. Fill in the Result.

## Result (filled in by the pilot)

**Delivered on 2026-09-27** (C7 pilot). Commits in the workspace root, no push:

- `feat(c7): hook UserPromptSubmit do digest voicecast (desligado até o gate)` [commit subject kept verbatim] —
  `scripts/lib/voicecast-context-digest.mjs` (pure node, pure functions
  exported) + `UserPromptSubmit` block in `zcode.json` with `"enabled": false`
  (minimal change: +16 lines, 0 removals).
- `feat(c7): skill voicecast p/ consumir artefatos das sessões` [commit subject kept verbatim] —
  `.zcode/skills/voicecast/SKILL.md` (WSL paths, F0 artifact contract,
  manual digest usage, telemetry/kill-switch).
- `test(c7): testes do digest voicecast + fixtures` [commit subject kept verbatim] —
  `scripts/lib/__tests__/voicecast-context-digest.test.mjs` (14 tests) +
  `scripts/lib/__tests__/fixtures/voicecast-session/` (fake meta.json and
  transcript.json, no secrets).

Evidence (verifiable acceptance):
- `node --test scripts/*.test.mjs` (root): 25/25 green — regression intact.
- `node --test scripts/lib/__tests__/voicecast-context-digest.test.mjs`: 14/14.
- Manual smoke: fake session in tmp (`VOICECAST_SESSIONS_ROOT`) → stdout is
  `{"additionalContext": "<digest markdown>"}` with title/duration/speech/
  judgment/paths; no session, old session (> window), missing root and
  kill-switch `VOICECAST_DIGEST=0` → silence, exit 0.
- Simulated stdin payload (real hook format): the prompt does NOT leak into the digest
  or the telemetry.
- JSONL telemetry in `~/.local/state/voicecast-digest.log` (guardrails
  pattern, `XDG_STATE_HOME` respected): one line per round with
  `inject`/`skip`/`error` — metadata ONLY (day, name, ageMin, durationS,
  relevancia, artifact counts, digestChars, ms).

Implementation decisions (for the maintainer's gate):
- The hook's output is `{"additionalContext": …}` and not raw markdown: ZCode's
  runner only injects context from JSON stdout (non-JSON stdout is
  ignored; JSON outside the schema marks the hook as failed —
  diagnosing-hooks docs). No output ⇒ injects nothing, no error.
- Speech in the digest only with `meta.jev.relevancia >= 2`; no judgment → metadata-only
  digest (strict briefing reading + Jev fail-soft).
- Bounded: speech ≤ 1000 chars, ≤ 8 screenshots and ≤ 4 clips listed (total count in
  "(+N mais)" ["(+N more)" — literal marker emitted by the script]).
- Recency = `startedAt + durationS` (fallback meta.json mtime) within
  `VOICECAST_DIGEST_MAX_AGE_MIN` (default 30); clock skew (negative
  age on the Windows mount) is accepted.
- Extra envs: `VOICECAST_DIGEST_NOW` (fixed now, deterministic tests) and
  kill-switch `VOICECAST_DIGEST=0` (house pattern).

Pending items (control tower):
- **Human gate**: turn on `"enabled": true` in the UserPromptSubmit block of
  `zcode.json` and validate with a real session on Windows (`pnpm dev:win`).
- Root `pnpm test:worktrees` doesn't pick up the new test (glob only
  `scripts/*.test.mjs` + `scripts/lib/__tests__/*.test.ts`) — widen the glob
  in an infra commit (left out of this WP's minimal scope).
- No real sessions yet in `/mnt/c/Users/pedro/AppData/Local/voicecast/sessions`
  on this machine — the real validation happens at the gate.

Findings: no relevant neighboring bugs.
