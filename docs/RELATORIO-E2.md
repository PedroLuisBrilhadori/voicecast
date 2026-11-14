# Stage 2 Report (MVP) — Jev judgment inside voicecast

Date: 2026-09-21 · Plan: [PLANO-JEV-CU.md](./PLANO-JEV-CU.md) · Previous:
[RELATORIO-E1.md](./RELATORIO-E1.md) (workspace foundation)

## Summary

| Item | Verdict |
|---|---|
| `src/main/jev.ts` + `jev-questions.ts` (official SDK, fail-soft, OTel metrics) | ✅ |
| F9 routes intent BEFORE pasting (`decidePaste`) | ✅ truth table tested |
| Dictation bar shows the outcome (not pasting has to explain itself) | ✅ |
| Finished session gains `meta.json.jev` + a line in `buildContext` | ✅ |
| Unit tests (mock, no network) | ✅ 23 passed (14 from jev) |
| Smoke with the real API | ✅ 3/3 (747ms command, 731ms dictation) |
| `pnpm ci:local` (typecheck + vitest + build) | ✅ |
| Windows sync reinstalls deps when `package.json` changes | ✅ (otherwise the SDK would be missing on the host) |

## What the MVP does

1. **Smart F9**: after ASR, one `systemone` call (choice, ~700ms)
   routes the dictation. `ditado_texto` → pastes as always. **`comando_agente`,
   `anotacao_contexto` and `conversa_social` with confidence ≥ 0.9 are NOT
   pasted** into the focused window — the bar shows the outcome ("→ agente (não
   colado)" ["→ agent (not pasted)"], "✎ guardado na sessão" ["saved to the session"], "— conversa (ignorada)" ["— chat (ignored)"]) for ~2.2s before
   closing. Confidence < 0.9 pastes (doesn't decide on its own). No key/off/error →
   pastes exactly as before (fail-soft — judgment is an enhancement, not a
   dependency).
2. **Judged session**: at the end of transcription, 4 questions in one call (~750ms)
   → `meta.json.jev = { model, judgedAt, rota, conf, relevancia, pedido, risco }`.
   "Copiar para o ZCode" ["Copy to ZCode"] (`buildContext`) includes the line
   `Julgamento (Jev …): rota … · relevância …/3 · pedido-de-ação … · risco …` (literal line emitted by the app: "Judgment (Jev …): route … · relevance …/3 · action-request … · risk …")
   — triage ready for the agent to consume (Stage 3 will use the pending `rota`
   `comando_agente` field).
3. **Observability**: `voicecast_jev_decisions_total{origem,status}` and
   `voicecast_jev_seconds{origem}` in the existing OTel; logs in main.log.

## Files

- New: `src/main/jev.ts`, `src/main/jev-questions.ts`, `tests/jev.test.ts`,
  `tests/jev.smoke.test.ts`.
- Changed: `src/main/ditado.ts` (judgment + decidePaste + outcome in the
  bar), `src/main/library.ts` (`meta.jev` + post-transcription judgment +
  line in buildContext), `src/shared/ipc.ts` (the `ditado-state` event gains
  `phase:"done"` + `rota/conf/colado`), `src/renderer/BarApp.tsx` (outcome),
  `scripts/sync-to-host.ps1` (reinstall by package.json hash),
  `package.json` (dep `@typesafe-ai/sdk`), `AGENTS.md`, `tests/ipc-contract.test.ts`.

## Windows setup (once, by the maintainer)

1. `pnpm dev:win` — the sync now reinstalls deps on its own (`.deps-hash` marker).
2. Jev key: `echo <TYPESAFE_API_KEY> > %APPDATA%\voicecast\jev-key.txt`
   (or export `TYPESAFE_API_KEY` in the app's environment).
3. Test: F9 + "abre um pull request…" ["open a pull request…" — example spoken goal] → bar shows "→ agente (não
   colado)" ["→ agent (not pasted)"]; F9 + e-mail text → "✓ colado" ["✓ pasted"]; finish a session →
   `meta.json` with a `jev` field.

## Verifications

- Unit (no network): `pnpm test` → 23 passed (fixtures = real probe
  responses; the `decidePaste` truth table is the F9's UX contract).
- Smoke (real API, jev-1.13.0): command → `comando_agente` 747ms;
  pure dictation → `ditado_texto` 731ms; session → relevance >1.5, high
  read-only risk. Run again:
  `VOICECAST_JEV_SMOKE=1 TYPESAFE_API_KEY=<key> pnpm vitest run tests/jev.smoke.test.ts`

## REAL Windows validation (2026-09-21/22) ✅

Setup executed: WSL build → sync (reinstalled deps: `added 1 package`) → key
in `%APPDATA%\voicecast\jev-key.txt` (via stdin) → real app on Windows.

| Test | Result |
|---|---|
| F9 paste branch (conf < 0.9) | `2134-c56ac751`: pasted 60 chars + `jev: rota comando_agente conf 0.88` — the confidence gate acted as designed |
| **F9 suppression branch** (conf ≥ 0.9) | `2137-190dcb89`: log `ditado: NÃO colado — rota comando_agente (conf 0.99)` ["dictation: NOT pasted — comando_agente route (conf 0.99)"], **no paste**, `meta.jev {rota comando_agente, conf 0.99}`, bar without error |
| Session with screen (`--autotest` 11.7s + marker) | `2137-9e85f08f`: real ASR (cuda, 19 words — TTS spoken into the mic) → headless `--transcribe` → **complete `meta.jev`** `{rota ditado_texto conf 0.28 · relevância 0.19 · pedido 0.72 · risco 0.52}` in 771ms |
| Jev with imperfect input | fragmentary transcript → LOW confidence registered (calibrated doubt is a feature) |

Validation notes:

- The F9 "spoken command" was used via `VOICECAST_DITADO_FAKE_TEXT` (skips ASR;
  the REAL speech into the mic was exercised in the session with TTS). New hook
  **`--ditado-test`** (index.ts): start→6s→stop without a physical key, same
  style as `--autotest` — the two become the standard way to validate on Windows.
- `SendKeys`/physical key couldn't be used by the agent (UIPI "Acesso negado"
  ["Access denied"] + global hotkey didn't fire with synthetic input) — hence the hooks.
- **Bug found and fixed during validation**: react 19.2.7 +
  react-dom 19.3.0 in the lockfile → React error #527 (blank bar in
  runtime). Aligned: exact `react-dom@19.2.7`; the bundle got back to ONE
  React version.
- Final machine state: app closed (dev instance), F9 returned to the
  daemon, no leftover processes. Key remains in
  `%APPDATA%\voicecast\jev-key.txt` (intended).

## Pending / next

- ~~Real run on Windows~~ **VALIDATED** (section above) — left: a test by the
  maintainer actually speaking into the F9 (human voice, no fake text) and the
  bar's visuals with the outcome in normal use.
- `comando_agente` still has no consumer → **Stage 3** (voicecast MCP +
  UserPromptSubmit hook) uses the `jev.rota` field from meta.
- Workspace guardrails are OFF by marker (since 19/09) — independent of
  this stage, re-arming is the maintainer's decision.
