# C6 — AN.4: annotations in buildContext · done

## Objective
"Copiar contexto p/ ZCode" ["Copy context to ZCode" — in-app button] (`buildContext`) now cites the session's
annotation marks (laser/brush + burned screenshots), so the consuming
agent knows WHAT was highlighted on screen, beyond audio/transcription.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (repo rules)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (this is where the new section goes; note the "Trechos" section as a format example)
- `/home/pedro/programing/projetos/voicecast/src/shared/annotations.ts` — pure
  engine: event types and log fold (source of truth of the format)
- `/home/pedro/programing/projetos/voicecast/src/main/annotations.ts` — how
  `annotations.jsonl` is written (field by field) and where burned screenshots live
- `/home/pedro/programing/projetos/voicecast/docs/PLAN-SCREEN-ANNOTATIONS.md` —
  plan decisions (WYSIWYG, D6/D7 screenshots)

## Scope
**Do:**
- In `buildContext` (src/main/library.ts): new section `Anotações (N):` (literal section name emitted by the app: "Annotations (N):") with, per
  mark: relative time (fmtTs), type (laser/stroke/erase…), and — when a matching burned screenshot exists in `frames/` — the
  `wslPathQuoted(...)` path of the PNG.
- jsonl read/aggregation logic in a new PURE function
  `src/shared/annotations-context.ts` (fold reusing the pure engine),
  testable without electron; `library.ts` only consumes.
- Telemetry (DoD): counter `voicecast_context_annotations_total` (number of
  marks included in the context; 0 also emits? no — only when there are some).

**Don't touch:** drawing/overlay engine, IPC, editor UI, asr/jev, runner.

## Verifiable acceptance
- `pnpm ci:local` green in `/home/pedro/programing/projetos/voicecast`.
- New test in `tests/annotations-context.test.ts` with a jsonl fixture
  (≥3 events: stroke, laser, clear) validating the generated summary.
- Test in `tests/` proving that `buildContext` includes the section when the
  jsonl exists (fs mock as the storage tests do) and doesn't break
  when it doesn't.

## Risks and gotchas
- `annotations.jsonl` may not exist (session without annotation) — the section simply
  doesn't appear (current Trechos section behavior).
- jsonl times are relative to the real `startedAt` (`recorder.start()`) —
  use fmtTs as in the other sections.
- Don't read screenshots from `frames/` beyond the existing ones (readdir + match by
  rounded timestamp, tolerant to not finding — line without path).

## Delivery
Conventional commits (`feat(c6): …`) in the repo, NO push. Fill in the
Result section below.

## Result (filled in by the pilot)
**Delivered (2026-09-27):**
- `src/shared/annotations-context.ts` (new, pure — no electron):
  `summarizeAnnotationEvents(jsonl, frameFiles)` does the tolerant parse of
  the jsonl + the fold via the pure engine (`foldEvents`) and returns the marks;
  `annotationSection(jsonl, frameFiles, framesDir)` returns the ready lines
  (`{ count, activeStrokes, skipped, lines }`, null when there are no marks).
  `fmtTs` (m:ss) moved to live here and `library.ts` imports it from here.
- `src/main/library.ts` — `buildContext` gained the `Anotações (N):` section
  (between Trechos and Julgamento): per mark, relative time + type; path of the
  burned screenshot via `wslPathQuoted(...)` only when the PNG exists in `frames/`
  (readdir; no match → line without path). Counter
  `voicecast_context_annotations_total` (DoD) declared alongside and emitted ONLY
  when there are marks (`add(count)` inside the section block).
- Tests: `tests/annotations-context.test.ts` (13 — jsonl fixture with
  stroke+laser+clear+screenshot, stroke↔burned-screenshot correlation, undo/redo,
  eraser in both modes, empty/corrupt jsonl, exact line render) and
  `tests/library-buildcontext.test.ts` (4 — section enters when the jsonl exists
  with the absolute screenshot path; no matching screenshot; empty jsonl; no jsonl
  doesn't break). Electron mocked (`app.getPath` → tmpdir) + real fs in a
  temporary directory.

**Evidence:** `pnpm ci:local` green in
`/home/pedro/programing/projetos/voicecast` (typecheck + 103 passed / 3
skipped — pre-existing skips, e.g. jev.smoke + main/preload/renderer build).

**Interpretation decisions (within the briefing):**
- pt-BR labels in the AN plan's vocabulary: `pincel` [brush], `laser`,
  `borracha (traço|área)` [eraser (stroke|area)], `limpar` [clear], `desfazer` [undo], `refazer` [redo], `print (marker|
  auto|manual)` [screenshot (marker|auto|manual)] — the briefing cited "laser/stroke/erase" as types; kept the
  PLANO-ANOTACOES-TELA nomenclature (the AN.4 example uses pincel/borracha).
  (Labels kept in pt-BR: they are literal strings emitted by the app's code, which is out of this scope.)
- Undo/redo also count as a mark (the log is the source of truth); the fold
  marks strokes that didn't survive to the end with `(apagado)` ["(erased)" — literal marker emitted by the app].
- Screenshot↔stroke correlation via the `print` event's `strokes` field (exact ids
  recorded by the engine), not by timestamp heuristic; the PNG's existence
  is checked against the `frames/` readdir (tolerant to not finding).
- The briefing asked for "fs mock as the storage tests do", but there is no
  storage test in `tests/`; used the pattern of the existing tests
  (agent-runner.test.ts): mocked electron + real fs in `os.tmpdir()`.

**Pending items:**
- Windows validation via `pnpm dev:win` is the wave's human gate (protocol —
  the pilot doesn't validate on Windows alone).
- The counter's emitted value follows telemetry-core's lazy pattern (emits on the
  first `add` after init); visual check stays for the Grafana dashboard
  (`voicecast`), like the other metrics.

**Findings (out of scope, untouched):**
- The pre-existing `fmtTs` rounds seconds: t≈59.7 formats as `0:60`
  (original math of library.ts's fmtTs, just moved to shared).
- The AN.4 format example in the PLAN (single line "Marcações: 6 (…)" ["Marks: 6 (…)" — literal app format]) was
  superseded by the briefing's format (numbered list, like Trechos) —
  briefing prevails; the plan doc was not changed.
