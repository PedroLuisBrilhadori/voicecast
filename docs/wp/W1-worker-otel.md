# W1 — Worker thread for the OTel SDK import · done

## Objective
Kill the REC delay residual: the OTel SDK import blocks the main process's event loop
for ~9s; move the telemetry init to a **worker_threads** (or
utilityProcess, justify the choice) so the main process never blocks.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (rules + Telemetry section)
- `/home/pedro/programing/projetos/voicecast/src/main/telemetry.ts` — current init
  (waits idle+15s, 5s retry; `stopTelemetry` with flush on will-quit)
- `/home/pedro/programing/projetos/voicecast/src/shared/telemetry-core.ts` — lazy
  core (counters/histograms resolve on first emit)
- `/home/pedro/programing/projetos/voicecast/docs/REPORT-TELEMETRY.md` —
  delay diagnosis (cause 2) and SDK gotchas (metricReaders, flush,
  VOICECAST_OTEL_DEBUG)

## Scope
**Do:**
- Initialize the OTel SDK in a separate worker; the main process keeps using
  the lazy core (in-memory API) and the worker exports (bridge: the same OTLP HTTP
  endpoint `localhost:4318`; worker message pattern for lifecycle/errors).
- If you choose utilityProcess instead of worker_threads, justify it in the briefing.
- Keep: kill-switch `OTEL_ENABLED=0`, diag `VOICECAST_OTEL_DEBUG=1`, flush on
  quit (the worker must be shut down WITH flush — see current stopTelemetry).
- Telemetry about the telemetry (DoD): a boot log/counter of the worker
  (e.g. `voicecast_telemetry_worker_started_total` or a span) so we know the
  new path is alive.

**Don't touch:** the existing instruments' contract (names/metricReader),
dashboards, capture/recorder, editor.

## Verifiable acceptance
- `pnpm ci:local` green; new tests: worker boots and reports ready; init in
  the main process doesn't block the event loop (timing test with a fake of the heavy SDK —
  follow the pattern of the existing telemetry tests).
- `--autotest` keeps working (don't break the existing smoke).

## Risks and gotchas
- The SDK in the worker doesn't share a process with the main process's emits — the current
  design (lazy core in main + export in worker) needs a bridge (e.g.:
  PeriodicExportingMetricReader proxy via messages, OR move the WHOLE core to the
  worker and the main only sends events). CHOOSE the simplest design that
  preserves the current Prometheus names and document it in the briefing.
- app.exit() loses flush — the worker's shutdown needs grace (the
  report documents the case).

## Delivery
Conventional commits, no push. Fill in the Result below.

## Result (filled in by the pilot)

**Delivered** (2026-09-27, W1 pilot). The OTel SDK import (~9s blocking the
main process's event loop) now runs in a **worker_threads**; the main process never blocks.

### Design decisions (briefing ambiguities, resolved and documented)

1. **worker_threads, not utilityProcess.** The cost is pure Node module
   import (CPU), nothing Chromium; thread spawn is cheap; messages
   are tiny (structured clone handles it) and the worker touches no Electron
   API. utilityProcess would only add process/IPC overhead with no gain
   for this case.
2. **Whole core in the worker; main only sends events** (the briefing's 2nd option —
   not the `PeriodicExportingMetricReader` proxy). A reader-proxy would require
   SDK code in the main process (heavy reimport) — defeats the objective. The worker
   reuses the SAME lazy `telemetry-core` and creates the instruments with the
   **names/descriptions arriving in the messages** → Prometheus names intact
   (`_total`, `_bucket/_sum/_count`, same exporter/5s interval/:4318).
3. **Span hierarchy preserved** (`session.start` → `recorder.load`/
   `recorder.open` exist today): `withSpan` in the main process keeps a span stack
   via `AsyncLocalStorage` and sends `span-start{id,parent,name,attrs,startMs}`
   / `span-end{id,endMs,error}`; the worker creates the real span with the parent via
   `trace.setSpan` and epoch-ms timing (`TimeInput` accepts `Date.now()` —
   verified in core 2.11).
4. **Semantics kept**: emits before ready stay discarded (as
   before init); `OTEL_ENABLED=0` checked in the bridge (no spawn) and in the
   worker (`disabled` message); `VOICECAST_OTEL_DEBUG=1` turns on the diag inside
   the worker; `stopTelemetry` = `shutdown` message → `sdk.shutdown()` (flush)
   → `shutdown-done` → terminate (10s timeout — grace for `app.exit()`,
   `--autotest`/`--transcribe` smokes keep calling it before exiting).

### Files

- `src/shared/telemetry-protocol.ts` (new) — message contract.
- `src/shared/telemetry-worker.ts` (new) — worker entry: real SDK init
  (moved 1:1 from the old telemetry.ts) + lazy core + **boot counter**
  `voicecast_telemetry_worker_started_total` emitted by the worker itself on
  ready (DoD: telemetry about the telemetry — comes out on the shutdown flush).
- `src/shared/telemetry-bridge.ts` (new) — spawn/lifecycle/meter bridge, pure
  Node (unit-testable; injected logging).
- `src/main/telemetry.ts` — rewritten OVER: identical public API
  (`counter`/`histogram`/`withSpan`/`initTelemetry`/`stopTelemetry`); no
  caller changed (capture/library/jev/ditado/annotations/agent/index).
- `tests/telemetry-worker.test.ts` (new) — 11 tests: protocol with injected SDK
  (boot counter, names/attrs, span hierarchy/timing/error, flush,
  kill-switch), bridge (kill-switch doesn't spawn, degrades without worker, emits in
  a real thread), **init doesn't block the event loop** (worker burns CPU 500ms;
  main's timers stay punctual — W1 bug regression) and **REAL worker**
  compiled via esbuild: boots, imports the real SDK and reports ready.

### Evidence

- `pnpm ci:local` green (WSL): typecheck + **114 tests passed** (3 skipped =
  conditional jev smoke) + build; `dist/shared/telemetry-worker.js` generated.
- Production artifact smoke (`dist/shared/telemetry-worker.js` via
  worker_threads): `init` → `{"type":"ready","endpoint":"http://localhost:4318"}`
  → `shutdown` → `shutdown-done` (flush ok).
- `--autotest` intact: `await initTelemetry()` stays in the same place
  (now resolves on the worker's ready, without blocking the loop).

### Findings (not fixed — out of scope)

- `src/main/index.ts` still schedules the init at idle+15s — historical
  mitigation of the 9s block that became unnecessary (the worker makes the init safe at
  any time; bringing telemetry up earlier = the tower's decision).
- The header of `src/shared/telemetry-core.ts` mentions "init 3s after ready" —
  description of the old design; core untouched (contract).

### Pending items

- Windows gate by the maintainer (`pnpm dev:win`): confirm that the SDK
  import in the worker doesn't collide with the REC start in the real world (the WP's
  objective) and the `voicecast_telemetry_worker_started_total` counter reaching
  Prometheus (dashboards intentionally untouched).
- Optional future: shorten/remove the init's 15s wait (finding above).
