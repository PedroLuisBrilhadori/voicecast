# voicecast — v2 vision (maintainer's decision, 2026-09-19)

## Decision

**voicecast is the v2 of voice-dictation**. They are not independent sibling products:
voicecast **absorbs the dictation** and the two systems converge. Decided by the
maintainer upon seeing the two apps capturing the same microphone in parallel without
knowing about each other.

### What each one becomes

| Today (voice-dictation) | In v2 (voicecast) |
|---|---|
| Python daemon + :8700 panel | **Gradually retired** — the Electron app takes over the UI and the capture |
| F9 dictation → ASR → pastes into the focused window | **F9 becomes a voicecast shortcut**: dictation is a capture mode (mic-only, no video) — same bar, same library, pasting into the focused window kept |
| ASR :8701 (local faster-whisper) | **Hosted by voicecast** (since 2026-09-22): the app spawns and supervises the vendored python service (`asr-backend/`) — access continues via HTTP `:8701`, but the runtime is now ours. The shared voice-dictation service retired. |
| Training dataset (`datasets/raw` + `transcriptions`, corrections in the panel, JSONL export) | **Natural evolution**: voicecast starts reading/writing the same dataset layout (same `words`/`corrections` schema) — corrections and training history keep counting; dictations and sessions converge into a single body of data |

### Why

- Today the same sentence can become two artifacts in two projects (the dictation
  dataset + the session mp4's audio track) with no link between them.
- Two UIs for the same voice (:8700 bar vs voicecast bar) splits the experience.
- voicecast already delivers the always-on-top bar, the media pipeline and the
  storage the dictation needs — duplicating it in Python makes no sense.

## Transition (while the daemon exists)

1. **Capture coordination via local API**: voicecast signals the daemon
   (:8700 endpoint) "session active" → the daemon suspends the F9 (panel shows
   "voicecast gravando" ["voicecast recording"]); if the dictation is capturing, voicecast warns in the UI.
   End of accidental double capture. (cheap, part of M2)
2. **Dictation in voicecast** (own milestone, after M2): F9 global → mic-only capture
   in Electron → end-of-speech detection → `POST :8701/v1/transcribe` → text to the
   clipboard + synthetic `Ctrl+V` in the focused window (port the SendInput from
   `voice/platform/win32.py` — INPUT struct with union, cbSize 40 — to FFI/koffi).
3. **Dataset integration**: voicecast writes dictations in the voice layout
   (same JSONs, same `words`), reads the existing history; JSONL export
   (`voice-export`) keeps pointing to the same corpus. The voice :8700 correction
   panel stays until voicecast has an equivalent screen.
4. **Daemon retirement**: only when F9 in voicecast reaches full parity
   (global hotkey, reliable pasting on both OSes, dataset intact, updated runbooks).

## Related backlog (issues on GitHub)

- System audio (WASAPI loopback) as an optional session track — today mic only.
- Dictation correction/labeling screen inside voicecast (replaces the :8700 panel).
