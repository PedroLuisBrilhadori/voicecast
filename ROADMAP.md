# ROADMAP

Planned work (the "room to grow"). Completed work and per-phase reports:
[docs/](docs/) and [CHANGELOG.md](CHANGELOG.md).

## In progress

### M4 — Polish
- [ ] External session import (drag mp4 → library)
- [ ] OTel telemetry: local dashboards (voice v2 parity) — SDK ✅
- [ ] Wayland/note: final multi-monitor QA round for region mode

## Next up

### M3 — Live mode
- [ ] Spike → UI: live session consumable by the agent while recording
- [ ] Jev gate: F9 routing → judgment before pasting (MVP ✅, fine-grained rules still missing)
- [ ] TTS in the panel (spoken feedback)

### W2 — Transcription correction and dataset
- [x] Pure correction engine + atomic writes to the corpus
- [x] Editor: clickable word → inline input, preserving timings
- [x] Dataset panel (list/search/filter, detail view with audio, labeling)
- [ ] Fine-tuning consuming the labeled corpus (training → evaluation loop)

### Pluggable ASR
- [ ] Abstract the transcription provider (currently: local faster-whisper via `asr-backend/`)
- [ ] Support an alternative local model and a user-chosen external API
- [ ] Settings: provider/model selection in the panel (counterpart to the `asrHost` toggle)

### Debt / quality
- [ ] Packaging (electron-builder: AppImage/DEB on Linux, NSIS on Windows)
- [ ] Remote CI (GitHub Actions) mirroring `ci:local`
- [ ] Document the IPC contract (`src/shared/ipc.ts`) generating reference docs
- [ ] E2E tests for the REC → transcribe → context flow (currently E2E is manual via `--autotest`)
