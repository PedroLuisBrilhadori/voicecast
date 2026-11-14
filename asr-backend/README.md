# asr-backend — vendored ASR service

Copy of the `voice` transcription service (faster-whisper + FastAPI), original
at `server-docs/workstations/shared/scripts/voice/src/voice/`. voicecast
**hosts** this backend: `src/main/asr-host.ts` spawns and supervises
`python -m voice.asr_service --port 8701` from the installed copy at
`%LOCALAPPDATA%\voicecast\asr-backend` (created by `scripts/setup-asr-backend.ps1`).

## Vendored subset (2026-09-22)

| File | Reason |
|---|---|
| `voice/asr_service.py` | The service itself (`/health`, `/v1/transcribe`, `/v1/tts`) |
| `voice/telemetry.py` | Imported by asr_service (best-effort; we run with `OTEL_ENABLED=0`) |
| `voice/platform/{__init__,common,win32,linux}.py` | `get_backend()` — dictation glue (`paste_into_focused`) and paths |

The daemon/panel/dataset modules did NOT come along (retired — VISION-V2).

## Divergence from server-docs

- `platform/common.py`: `app_dir()` honors the `VOICE_APP_DIR` env (the voicecast
  host sets the backend data root). Without the env, the original behavior
  is preserved.

## Updating from server-docs

```bash
SRC=../server-docs/workstations/shared/scripts/voice/src/voice
cp $SRC/asr_service.py $SRC/telemetry.py voice/
cp $SRC/platform/*.py voice/platform/
# reapply the VOICE_APP_DIR patch in voice/platform/common.py (see above)
```

Whisper models live in the user's HF cache (`~/.cache/huggingface`) —
shared across venvs, no re-download.
