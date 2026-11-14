# W2a — Dictation correction screen + dataset integration (issues #3+#5) · done

## Objective
Close the gap left by the voice-dictation retirement: correct/label
dictations INSIDE voicecast (the :8700 panel died with the daemon) and talk
to the historical training dataset (same corpus, words/corrections layout).

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/docs/VISION-V2.md` — the dataset
  integration decision (item 3) and the correction screen (replaces the panel)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (repo rules)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGATION.md` (protocol)
- Voice dataset layout (historical corpus): datasets in
  `/mnt/c/Users/pedro/AppData/Local/voice-dictation/datasets/` — INSPECT
  (read-only!) the real schema of `transcriptions/` and `corrections/` (words,
  corrections, ids, timestamps) before designing; voicecast MUST read and
  write the SAME layout (issue #3). There is no spec — the corpus is the spec.
- Current editor: `src/renderer/EditorApp.tsx` (per-word transcription already
  clickable — correction re-edits words in place), `src/main/library.ts`,
  `src/shared/ipc.ts` (the contract is law: change here → preload + main + tests).

## Scope
**Do:**
1. **Correction in the editor** (dictations = sessions with mode:"ditado"): a "correct
   transcription" mode that allows editing the transcription's text/words and records the
   correction (updated transcript + correction field in meta/dataset).
   Minimum viable: edit the wrong word(s), preserve timings.
2. **IPC/contract**: new channels to save the correction (+ contract tests).
3. **Dataset integration** (whatever the corpus allows): write the correction in the voice layout in
   `%LOCALAPPDATA%\voice-dictation\datasets\` (same structure the JSONL export consumes). Fail-soft: without a datasets dir, save
   only in voicecast (meta/transcript) and flag it in the UI.
4. **Telemetry (DoD)**: counter `voicecast_corrections_total{alvo}` (voicecast|dataset|ambos).

**Don't touch:** capture/paste pipeline (recently fixed), cockpit (Wave 1),
runner/runtime-setup, picker panel.

## Verifiable acceptance
- `pnpm ci:local` green; tests: correction preserves timings; writes to both
  targets when the dataset exists; fail-soft when it doesn't; IPC contract.
- The `--ditado-test` smoke stays deterministic (don't break the hook).

## Risks and gotchas
- The voice corpus is REAL training DATA — write with backup/atomic
  (tmp+rename), never truncate; never point tests at the real corpus.
- Layout discovered in the old panel's code if necessary: the
  voice-dictation repo may be in `~/programing/projetos/voice-dictation` (if
  it exists) or in the data; the disk rules.
- Old dictations saved WITHOUT words (the fake hook records words:[]) — correction
  must handle plain text too.

## Delivery
Conventional commits (`feat(w2a): …`), no push. Fill in the Result below.

## Result (filled in by the pilot)

**DELIVERED (2026-09-29)** — commits `1dda3f6..fa00a6a` (+docs). `pnpm ci:local`
green: 219 tests (185→219, +34 from W2a), typecheck and build ok. No push.

### Schema discovered in the corpus (the disk is the spec)
- `datasets/transcriptions/YYYY-MM-DD/<HHMMSS-hash8>.json`: `id`, `ts` (local
  ISO without Z), `audio` (relative `raw/<day>/<id>.wav`), `duration_s`, `text` (RAW),
  `chars`, `confidence`, `device`, `paste_mode`, `model`, `language`,
  `source`, `n_words`, `words: [{w,start,end,p}]`, `quality`, `validation`,
  `ready_for_export`. There are also `raw/<day>/<id>.wav` and `drafts/` (status).
- Correction in the corpus = a `validation` block in the SAME JSON (discovered in the
  old panel's code `voice-dictation/src/voice/corrections.py`, since
  no corpus item has validation yet):
  `{corrected_text, ts, n_edits, edits:[{index,original_w,corrected_w}], labeled_by}` —
  raw `text` NEVER changes; atomic tmp+replace write; idempotent.

### What was delivered
1. **Pure engine** `src/shared/corrections.ts`: sanitizeEdits (same rules as
   corrections.py), applyEditsToWords (timings preserved), buildValidation,
   id guard (no traversal), datasetRootFrom (`VOICECAST_DATASET_DIR`
   override → `%LOCALAPPDATA%\voice-dictation\datasets`).
2. **Corpus** `src/main/dataset.ts`: list (labeled search/filter, most
   recent first), detail (words/validation/audio) and writeDatasetCorrection
   (validation, tmp+rename, fail-soft "ausente"/"erro" [missing/error — literal status values]).
3. **IPC** (contract tested): `library:save-correction`,
   `library:open-corpus`, `dataset:list-items`, `dataset:get-item`,
   `dataset:save-correction` + payloads (`CorrectionEdit`, `CorrectionResult`
   with alvo/dataset, `ValidationBlock`, `DatasetItemSummary/Detail`).
4. **Session correction** (`library.saveCorrection`): transcript.json with
   words edited IN PLACE (timings/conf preserved) and recomposed text — or
   plain text swapped when words is empty (fake hook/old dictations);
   `meta.correction` (correctedAt/nEdits/dataset); dataset via
   `meta.datasetId` → target `ambos`/`voicecast`; counter
   `voicecast_corrections_total{alvo}`; sessions-changed broadcast.
5. **UI**: the dictation session editor gains ✏️ corrigir ["correct"] (clickable word becomes
   an inline input; textarea for plain text; ✓ corrigido ["corrected"] badge; 📚
   dataset button). New `?corpus` screen (editor window reused, `--open-corpus[=id]`)
   replaces the :8700 panel: search, filter (all/without correction/labeled),
   detail with audio + correction.
   (UI labels kept in pt-BR: they are literal strings rendered by the app's code, which is out of this scope.)

### Decisions
- **The session↔corpus link is explicit** (`meta.datasetId`): voicecast dictations are
  not written to the corpus today (writing a new dictation in the voice layout — wav +
  words — was out of the briefing's scope and would touch the capture pipeline),
  so sessions without a link stay `alvo=voicecast` (dataset "missing"); the
  `ambos` path is implemented and tested for when the link exists. Correcting
  historical CORPUS items (the :8700 panel's case) goes through
  `dataset:save-correction` (target=dataset).
- `labeled_by: "voicecast"` (the old panel used "panel").

### Acceptance
- ✓ correction preserves timings (corrections/correction-save tests)
- ✓ writes to both targets when the dataset exists (fixture; NEVER the real corpus —
  tests use `VOICECAST_DATASET_DIR`/explicit root in tmp)
- ✓ fail-soft when it doesn't exist (dataset "missing", UI flags it)
- ✓ IPC contract (stable channels + serializable payloads)
- ✓ `--ditado-test` intact (ditado.ts/pythonEnv untouched)

### Pending items / findings
- Maintainer's gate (Windows): validate the 📚 dataset screen against the real corpus
  (read-only in WSL here) and an F9→correct end to end.
- Writing NEW dictations to the corpus (full VISION-V2 item 3: wav in raw/ +
  words + automatic meta.datasetId link) — issue #3 doesn't close 100% without it;
  requires webm→wav conversion and touching the capture pipeline (forbidden here).
- Neighboring finding (not fixed, strict scope): `EditorApp.tsx` hardcodes
  `C:\\Users\\pedro\\...` in the "abrir pasta da sessão" ["open session folder"] button.
