# Changelog

## [Unreleased] - 2026-10-22

### Added

- **Transcription model switch**: settings.json `asrHost` (panel →
  🗣 transcription, IPC `asr:host-get`/`asr:host-set`) toggles the local ASR
  host on/off — switching it off at runtime immediately kills the python
  service (GPU freed) and booting with the switch off doesn't load the model.
  Pure decision logic in `asr-host-logic.ts` (`asrSwitch`); env
  `VOICECAST_ASR_HOST=0` still overrides everything.

## [Unreleased] - 2026-09-23

### Added

- **[m2]** Editor phase B — multi-segment: named excerpts persisted in `meta.json`
  (pure engine `src/shared/segments.ts`, sanitized in the main process), visual
  timeline in the player, editable list (rename/✂ clip/▶ play/✕), **export cut**
  (concatenates all segments into a single mp4, `clips/corte-<N>seg.mp4`) and
  the list of existing clips in the editor (phase A recorded but didn't list
  them). `buildContext` gains the `Trechos` (Excerpts) section with each
  segment's speech + the clip/cut path. Telemetry: `voicecast_cuts_total` and
  `voicecast_cut_seconds`.

## [Unreleased] - 2026-09-22

Window: 2026-09-19 → 2026-09-22. From zero to v2: Electron foundation, full
capture (screen/window/region) + post-production, absorption of the
voice-dictation (F9 dictation, own ASR) and on-screen annotations.

### Added

- **[m0]** Electron foundation: Ctrl+F9 global shortcut, typed IPC, storage layout, CI and WSL→Windows dev loop (3c4de4c)
- **[m1]** Full session capture: picker (screen/window/region), selection overlay, REC bar and session pipeline (e23ad1a)
- **[m2]** Post-production: ASR transcription, synced editor, clips, screenshots, library and context for ZCode (bf6a70d)
- **[v2]** F9 dictation inside voicecast, with ownership coordination with the daemon (issues #1, #2) (41c6913)
- **[v2]** Elaborated history: dictation persists as an audio session + library with full-text search (fa02415)
- **[v2]** OTel telemetry (voice v2 parity) + "transcribing…" feedback in the dictation bar (01def3f)
- **[jev]** MVP Stage 2: F9 routes before pasting + sessions with `meta.jev` (113bcff)
- **[an]** On-screen annotations (laser/brush/eraser/undo) + burned-in screenshots (AN.1/AN.2) (aac37fd)
- **[an]** Standalone annotation panel: Ctrl+Alt+H global opens the panel outside a session; recording/dictation adopt the open panel, preserving pre-REC strokes (4afef1a)
- **[an]** Extra shortcut Ctrl+Alt+X clears the annotations, alongside Ctrl+Alt+C (c1445a0)
- **[asr]** voicecast hosts its own transcription backend — end of the voice-dictation dependency (38fcc5c)
- **[tel]** OTel metrics truly alive (lazy core in `shared/telemetry-core.ts`) + start instrumentation: `session_starts_total`, `session_start_seconds{stage}`, spans `session.start`/`recorder.load`/`recorder.open`/`sources.list` and Grafana dashboard `voicecast` (in unidocs)
- **[tel]** REC bar opens instantly ("preparando captura…" ["preparing capture…"] with `arming`) and the session clock becomes the real `recorder.start()` — timer/duration/markers match the mp4 and the transcript

### Changed

- **[an]** Annotation palette on demand: REC and dictation no longer open the palette (hidden by default; `Ctrl+Alt+H` shows it) — the overlay stays alive in pass-through, with D6/D7 screenshots, Ctrl+Alt+P and hotkeys intact; the standalone panel and `--anoui` keep the palette visible (maintainer's review of D2)
- **[docs]** v2 vision: voicecast absorbs the voice-dictation (maintainer's decision) (fa66a4a)
- **[docs]** On-screen annotation plan (laser/brush/eraser/undo, screenshot in transcription mode) with decisions confirmed by the maintainer: WYSIWYG, shortcuts, fixed palette, screenshot in both modes, laser persisting its path in `annotations.jsonl` and automatic burned-in screenshot when annotating in transcription-only mode (306945b, d4409e3, 86d2b7e, cde5b77)
- **[ci]** pnpm version now comes from `packageManager` in `package.json` (21c4d5f)

### Fixed

- **[v2]** F9 ownership with heartbeat TTL — end of the double F9 on the transition (4a7b059)
- **[v2]** Pasting via the daemon's `paste_into_focused` (proven code, in place of SendKeys) (7efc223)
- **[an]** Agent-driven UI validation: 3 bugs fixed + eraser slack (df12a11)
- **[an]** Demands from the 0933 video: visible mouse on the laser, movable palette, overlay no longer gets stuck; hide palette + screenshot button on the palette (a501b1a)
- **[an]** Palette truly hidden — JSX ignored the `palHidden` state (button/shortcut changed the state, but the palette kept rendering) (8b71f73)
- **[tel]** Inert metrics bug: counters/histograms created at module-load captured a `null` meter (init is 3s after ready) and never recorded — only the spans were being emitted

### Removed

- **[recorder]** Debug instrumentation of recorder chunks (hex) (af34a54)
