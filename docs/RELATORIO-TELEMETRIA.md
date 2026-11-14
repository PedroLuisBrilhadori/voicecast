# RELATORIO-TELEMETRIA — OTel working + REC delay fix (2026-09-22)

Milestone: voicecast's OTel telemetry **actually working** (the metrics
existed in the code but none reached Grafana) + instrumentation of the
start pipeline + fix of the perceived delay between the recording request and the
REC bar.

## Context and finding

- `src/main/telemetry.ts` declared 7 counters/histograms at **module-load**,
  but the OTel SDK init is late (`index.ts`, 3s after ready, to not block the
  F9 daemon probe). With the meter still `null`, the factories returned `null`
  and **all metrics stayed inert forever** — only 2 spans
  (`session.finalize`, `ditado.stop`) were actually emitted.
- The **start** pipeline had no instrumentation at all — that's where the
  delay reported by the maintainer lived (REC bar appearing with ~8–10s on the timer).
  Cause: `startBar()` only ran AFTER the screen + mic `getUserMedia`
  (sequential, seconds on Windows), and the timer counted from `startedAt`
  (fixed before warm-up). In other words: the clock showed time the video didn't even have.

## What changed

### F0 — living metrics

- **`src/shared/telemetry-core.ts` (new, pure)**: lazy registry — the
  instrument is resolved on the first `add/record` with the post-init meter and
  cached by name (a duplicate declaration falls into the same instrument). Emit
  before init is discarded without throwing.
- `src/main/telemetry.ts`: factories now come from the core; init injects the real
  meter (`core.setMeter`). Kill-switch `OTEL_ENABLED=0` and
  `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) kept.
- Dedupe: `voicecast_sessions_total` stayed only in `capture.ts` (the orphan
  declaration in `library.ts` is gone).
- Tests: `tests/telemetry.test.ts` (doesn't throw before init; records after init;
  cache by name; `setMeter(null)` degrades).

### F1 — instrumented start + immediate bar (delay fix)

- **REC bar born instantly**: `startRecording` creates the bar and the preview
  BEFORE capture warm-up. New state `RecordingState.arming` — the bar
  shows "⏳ preparando captura…" ["⏳ preparing capture…"] and locks marker/pause/stop (stop during
  arming = clean cancellation).
- **True clock**: the recorder (`recorder.ts`) returns `startedAtReal`
  (the `Date.now()` of `recorder.start()`) and the main process adopts it — timer, `durationS`
  of `meta.json` and markers now match the mp4 content (and the
  transcription).
- **New metrics/spans**:
  - `voicecast_session_starts_total{mode,outcome=ok|erro}` (counter)
  - `voicecast_session_start_seconds{mode,stage=total|gum-desktop|gum-mic}`
    (histogram — separates the cost of screen vs mic `getUserMedia`)
  - spans `session.start` (with children `recorder.load`, `recorder.open`) and
    `sources.list` (fullscreen flow lists sources before recording).
- The start breakdown also goes to the log: `start ok: total=…s (desktop=…ms mic=…ms)`.

### F3 — Grafana dashboard

- `unidocs/volumes/grafana/dashboards-json/voicecast.json` (uid `voicecast`,
  committed in the unidocs repo — file provider, same home as the
  `agentes-*`/`voice-*` dashboards): sessions per mode, starts per outcome,
  **start p50/p95 (the delay panel)** + average per stage, finalize p50/p95,
  ASR p50/p95 and per status, dictations, Jev decisions, annotation events/screenshots.
- Data flow: voicecast (Windows) → OTLP HTTP `localhost:4318` (collector
  of unidocs' `pnpm docker:observability`) → Prometheus/Tempo → Grafana
  `localhost:3001`.

## Validation (real, Windows + Grafana — 2026-09-23)

- WSL: `pnpm ci:local` ok (typecheck + 61 tests + build), including the new
  telemetry-core tests; dashboard queries validated against the Grafana API.
- **Prometheus received the app's metrics**: `voicecast_sessions_total` = 1,
  `voicecast_session_starts_total` = 1, `voicecast_session_start_seconds_count`
  = 3 (stages total/gum-desktop/gum-mic) after `--autotest`; collector with
  positive delta and **zero new failures**.
- **Real warm start breakdown**: total **1.18s** · gum-desktop **0.27s**
  · gum-mic **0.26s** — capture is fast; the reported 8–10s delay had ANOTHER
  cause (below).
- Traces `session.start`/`recorder.load`/`recorder.open`/`sources.list` in
  Tempo (service `voicecast`).
- **Visual check of the dashboard** (panels/legends/units) pending from the
  maintainer: http://localhost:3001/d/voicecast.

## Diagnostic findings (the "delay" had two floors)

1. **Bar after capture** (fixed in F1): the bar was only born after the
   getUserMedia — now it's born instantly ("preparando captura…" ["preparing capture…"]).
2. **The OTel SDK import blocks the event loop for ~9s**: measured in the
   cold start autotest (`start ok: total=9.97s` with desktop=218ms/mic=221ms — the
   `telemetria: OTLP para` ["OTLP telemetry up"] log only finished AFTER 9s, colliding with the start).
   Mitigation: OTel init now waits **idle + 15s of life** (5s retry);
   `--autotest` initializes telemetry BEFORE measuring (stable path).
   Residual: a recording started during the ~9s the import runs still collides —
   the future definitive fix = SDK import in a worker thread.
3. **Infra (unidocs)**: the collector's remotewrite discarded whole batches
   with `out of order sample` **since 2026-09-19** (~98k points accumulated) —
   producers with clocks ahead (Windows: measured skew of ~2.2s from WSL2) and
   queue replays. Fix: Prometheus `v3.0.1 → v3.13.3` +
   `storage.tsdb.out_of_order_time_window: 10m` (the config doesn't exist in
   v3.0.1; in v3 it became a config key, not a CLI flag). OTLP→collector
   →Prometheus probe validated before/after.
4. **App exited without flush**: the reader only exports every 5s and the `app.exit()`
   of the smokes lost the cycle — `stopTelemetry()` (shutdown+flush) on
   will-quit and on the hooks that exit. Export error detection:
   `VOICECAST_OTEL_DEBUG=1` (diag logger, silent by default).

## Notes

- Emits before init (idle ≥15s) are discarded by design — small
  window, documented in telemetry-core.
- Prometheus names: counters with `_total`, histograms generate
  `_bucket/_sum/_count` — validated end to end.
- Next blocks (out of scope): dictation-start/ASR host/boot/global errors/
  `clip_seconds`; logs → Loki (OTLP handler); worker thread for the SDK
  import; WSL2 clock re-sync (hwclock) in the infra.
