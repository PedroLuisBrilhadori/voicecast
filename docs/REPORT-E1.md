# Stage 1 Report — Jev foundation: a single client

Date: 2026-09-21 · Scope: `projetos` workspace (root scripts) · Plan:
[PLAN-JEV-CU.md](./PLAN-JEV-CU.md)

## Summary

| Item | Verdict |
|---|---|
| Canonical client `scripts/lib/jev-judge.mjs` (official SDK inside) | ✅ created |
| Drift fixed (`boolean` → only `noul\|choice\|score`; new `choice`) | ✅ with validation at the boundary |
| Questions/thresholds in a single file (`lib/jev-questions.mjs`) | ✅ PAUSE + QA_RUBRIC + ranges |
| Migration of the 3 callers (guardrail, qa, calibrate) | ✅ behavior preserved |
| Golden tests with a REAL API response recorded | ✅ 5/5 |
| Workspace suite | ✅ 121/121 |
| Live verification (client + qa + calibrate) | ✅ 723ms · verdicts identical to the probe |
| JSONL telemetry (`~/.local/state/jev-judge.log`) | ✅ events with origin/tokens |

## What changed

- **`scripts/lib/jev-judge.mjs`** (new): canonical plain-ESM client over
  `@typesafe-ai/sdk@0.6.0` (installed at the root). House shell
  `{state, questions} → {respostas, model, latenciaMs, usage}`; injectable `fetch`
  for tests; `timeoutMs` per attempt + `maxRetries` (default 1;
  hooks pass 0); questions validation that rejects drift (e.g. `boolean`)
  with a message pointing to the fix; re-exports `APITimeoutError`.
- **`scripts/lib/jev-questions.mjs`** (new): PAUSE (the guardrail question),
  JEV_THRESHOLD (0.7), QA_RUBRIC and QA_RANGES — single reviewable
  file (guidance from the official TypeSafe doc).
- **`scripts/jev-guardrail.mjs`**: inline fetch → `jevJudge` (1 attempt,
  JEV_TIMEOUT_MS budget preserved); question imported from
  jev-questions.mjs; fail-open and stderr messages identical; kill-switch and
  gray zone untouched.
- **`scripts/jev-qa.ts`**: `jevScore` via the canonical client; verdict uses
  QA_RANGES; CLI output identical.
- **`scripts/jev-calibrate.ts`**: uses the SAME PAUSE as the hook (the local text
  had subtle drift — "irreversible destruction" vs "…or overwriting…" —
  calibration now re-evaluates exactly the production question).
- **`scripts/lib/jev-judge.ts`**: now a typed facade of the .mjs (stable import
  path for tsx); types fixed (noul|choice|score + legend/choice).
- **`scripts/jev-judge.test.mjs`** (new): golden tests with the REAL
  response of the 2026-09-21 probe (recorded contract becomes regression) — payload (URL/auth/
  model/criteria), round-trip of PAUSE, rejection of `boolean`, validations and
  JSONL telemetry (ok:true/ok:false).

## Live verifications (real API, 2026-09-21)

- voicecast probe scenario via the canonical client: `jev-1.13.0` · **723ms** ·
  812in/120out · `comando_agente` route 0.98 · request 0.98 · risk 0.97 ·
  relevance 2.93/3 — identical to the probe with raw fetch.
- `jev-qa`: APPROVES 3.86/4 (conf 0.88) · exit 0 · output format identical.
- `jev-calibrate --limit 2`: 0 errors, 0 divergences, 1 borderline.

## Pending items / observations

1. **Guardrails OFF by marker since 19/09** (jev, mimosa, questions —
   maintainer's decision). The hook e2e (stdin → API → exit 2) didn't run because of
   this; everything else on the path is covered (unit + golden + live). Re-arming
   the markers re-enables the end-to-end test — maintainer's decision.
2. Ingestion of `jev-judge.log` by the otel-sidecar not verified (events
   land in the file in the same pattern as the others; check whether the sidecar covers the
   new file → dashboard).
3. Pre-existing modifications in the working tree (vault-docs*.ts, unrelated to
   this stage) were not touched.
4. Commits: pending (maintainer decides — files: package.json,
   pnpm-lock.yaml, scripts/jev-*.{mjs,ts}, scripts/lib/jev-*.{mjs,ts}).

## Next step

Stage 2 (judging inside voicecast): `src/main/jev.ts` +
`jev-questions.ts`, post-session into `meta.json`, F9 routing with
confidence gate ≥0.9.
