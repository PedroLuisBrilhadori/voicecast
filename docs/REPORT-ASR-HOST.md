# Report — Hosted ASR: voicecast hosts the transcription backend (2026-09-22)

## Context

The session `2026-09-22/0933-7329b0fb` (recording test) ended with
`transcriptStatus: "sem-asr"`: voicecast was merely an HTTP client of the
shared `:8701` service of voice-dictation, and that service was killed at ~09:33
during the hangs diagnostic session (voice-dictation retirement).
VISION-V2 promised "voicecast absorbs the voice-dictation", but the absorption
never reached the transcription backend — it stayed at UI/capture/F9/library only.

## What changed

1. **`asr-backend/`** — subset of the `voice` python vendored into the repo:
   `asr_service.py`, `telemetry.py`, `platform/{__init__,common,win32,linux}.py`.
   Only divergence vs server-docs: `app_dir()` respects `VOICE_APP_DIR`
   (the host defines the data root). Daemon/panel/dataset didn't come
   (retired).
2. **`src/main/asr-host.ts` + `src/shared/asr-host-logic.ts`** — supervisor in the
   main process: `/health` probe before any spawn (never duplicates a
   service that already answers — an external one is adopted), respawn with
   5s→10s→20s→40s→60s backoff, reset after 60s stable, child logs in
   `logs/asr-backend.log`. Called on `whenReady`; kills the child on
   `will-quit`. Fail-soft: any error only logs.
3. **`scripts/setup-asr-backend.ps1`** — installs into
   `%LOCALAPPDATA%\voicecast\asr-backend` the synced src + its own venv
   (uv, python 3.12, faster-whisper + CUDA wheels) + a CUDA DLL sitecustomize.
   Idempotent (deps hash). Models: user's HF cache, no re-download. `-Check` only reports state.
4. **`src/main/ditado.ts`** — paste (`voice.platform`) now resolves the
   backend python/src of voicecast first, with legacy fallback
   (voice-dictation) during the transition; spawns carry `VOICE_APP_DIR`.

Decisions: the service's OTel stays **off** (`OTEL_ENABLED=0` on spawn — the
own venv doesn't install OTel deps; best-effort by design in telemetry.py). The
port stays `8701` and the client (`asr.ts`, URL failover) didn't change —
zero-access-change migration. Kill-switch `VOICECAST_ASR_HOST=0`; external
endpoints via `VOICECAST_ASR_URLS`/`VOICE_ASR_URLS` disable hosting.

## Validation

- WSL: typecheck + vitest (45 ✓, incl. 6 new for `asr-host-logic`) + build.
- Windows (real, 2026-09-22 ~10:07): `setup-asr-backend.ps1` — own venv +
  36 packages (CUDA wheels incl.), synced src, sitecustomize OK. Smoke
  `--transcribe=2026-09-22/0933-7329b0fb` (the session that motivated it all):
  `exit=0`, `transcript.json` generated (121 words, pt, large-v3-turbo),
  `meta.json.transcriptStatus: done`, session Jev judgment ok
  (`comando_agente` route). App relaunched: backend hosted by the app, health
  `{"status":"ok","device":"cuda"}`, child stdout in `logs/asr-backend.log`.

### Lessons along the way

1. **`.ps1` must be 100% ASCII** (PowerShell 5.1 reads BOM-less as ANSI —
   accents break the parse; same reason for the "c-pia" comments in
   sync-to-host.ps1).
2. **Cold start race**: `--transcribe` called `asrHealth()` ~300ms
   after `whenReady`, before python opened the port (~13s) → marked
   `sem-asr` and exited. Fix: `asrHealth({ waitMs })` with 1s retry and
   session transcription waits 30s (the port opens early; model
   load continues in background and `/v1/transcribe` waits for it server-side).
3. **Child lifecycle**: with `app.exit()` (the `--transcribe` path),
   `will-quit` does NOT fire and `stopAsrHost` doesn't run — but the child dies with
   electron anyway (inherited job object), no orphans. Verified:
   the next relaunch did a clean spawn.
4. The uv venv's `python.exe` is a trampoline that re-executes the managed CPython
   — **2 PIDs is 1 service** (don't confuse with duplication, as happened in
   the hangs diagnostic).

## Pending items

- Pasting still spawns the backend's python (proven code from win32.py). Port
  to native FFI (koffi) remains as an evolution — it was a VISION-V2 item, but
  rewriting the canonical SendInput reopens the INPUT struct bug; python kept
  until there's a real reason.
- voice-dictation launcher mystery at logon (session
  sess_0fb5aee6): something brings up the old supervisor on boot — if it comes back, the
  asr-host adopts the external service (without duplicating), but the definitive
  cleanup (deleting `%LOCALAPPDATA%\voice-dictation`) depends on finding the launcher.
- Hosting on Linux (note) not implemented — there the remote ASR
  (`asr-remoto-pchome.md`) continues via `VOICECAST_ASR_URLS`, which already disables
  hosting.
