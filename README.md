# voicecast

Context sessions: you talk and show your screen — voicecast records **voice + video**
locally, transcribes with the local ASR engine (faster-whisper served at `127.0.0.1:8701`)
and turns the session into **references consumable by coding agents**
(named excerpts, screenshots, transcripts with timestamps, ready-to-paste context).

Everything is 100% local (nothing leaves the machine).

**Who it's for:** developers who work with coding agents
(Claude Code, ZCode, Copilot...) and need to explain context live —
demonstrating a bug on screen, dictating a requirement, showing a behavior —
and want it to turn into reusable material (transcript, screenshots, clips)
without manual copy/paste.

## How it works

1. **Record** — a global shortcut opens the picker: full screen, window, or region.
   Floating REC bar, ffmpeg pipeline (fMP4 → MP4).
2. **Transcribe** — when the recording stops, the bundled ASR backend
   (faster-whisper + FastAPI, GPU when available) generates the transcript
   with per-word timestamps.
3. **Edit** — editor synced with the player: named excerpts, exported cuts,
   screenshots, clickable transcript correction.
4. **Consume** — "copy context" builds a block with the transcript, excerpts,
   file paths, and screenshots, ready to paste into your conversation with the agent.

Also included: **voice dictation** (F9, pastes directly into the focused app),
**on-screen annotations** (laser/brush/eraser overlaid on the recording), and a
searchable full-text session **library**.

## Stack

- **Electron** (main: windows, capture, ffmpeg, typed IPC; renderer: React 19 + Vite + TS)
- **ffmpeg** for recording/remux/cuts
- **Python** (faster-whisper + FastAPI) in the ASR backend vendored at `asr-backend/`
- **OpenTelemetry** optional (OTLP HTTP metrics/traces)
- Tests: **Vitest** (IPC contract, paths, session layout, pure engines)

> **About the ASR:** the `asr-backend/` is a **transcription engine that runs
> locally, on the user's machine** — voicecast is not (and does not intend to be)
> an AI-serving product: it does not serve models to third parties, does not host
> remote inference, and does not send anything off the machine. The engine is an
> implementation detail: the roadmap includes a **pluggable** transcription
> provider (another local model, or an API of the user's choice).

## Running

Requirements: Node 22+, pnpm 10, ffmpeg on PATH, Python 3.11+ with CUDA
(optional — without a GPU the ASR runs on CPU, which is slower).

```bash
pnpm install          # (--ignore-workspace if you're inside a pnpm workspace)
pnpm build            # main + preload + renderer

# Linux (Arch/KDE Wayland — current dev machine)
scripts/setup-asr-backend.sh   # installs the ASR backend (once)
scripts/run-linux.sh           # starts the app (VOICECAST_OZONE=wayland for native mode)

# Windows (legacy, WSL era — build in WSL, run on the host)
pnpm dev:win
```

Shortcuts: **Ctrl+F9** panel · **Ctrl+Shift+F9** record full screen ·
**F9** dictation · **Ctrl+Alt+H** annotation panel.
On KDE Wayland, global shortcuts require a manual binding in the KCM
(`kcm_keys`) — the app registers them, but KWin won't bind them on its own.

### Data

Sessions live in Electron's userData, one folder per session
(`sessions/YYYY-MM-DD/<hhmm-hash>/` with `session.mp4`, `meta.json`,
`transcript.json`, `clips/`, `frames/`, `thumbs/`):

- Linux: `~/.config/voicecast/sessions/`
- Windows: `%APPDATA%\voicecast\sessions\`

Settings live in `settings.json` next to it (e.g. `asrHost` toggles the
ASR backend at runtime, freeing up the GPU).

## Development

```bash
pnpm ci:local   # typecheck + tests + build — the gate for every commit
pnpm test       # vitest
```

The project anatomy (windows, IPC, storage, commit conventions) is in
[AGENTS.md](AGENTS.md); decisions and per-phase reports in [docs/](docs/).

Future work plans: [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
