/**
 * voicecast OTel telemetry — parity with voice/telemetry.py (v2).
 * Metrics + traces via OTLP-HTTP to the local collector (:4318, unidocs
 * observability stack). Graceful degradation: collector down → nothing breaks.
 *
 * W1: the whole OTel SDK (the ~9s import that blocked the main event loop)
 * moved to a worker_threads — src/shared/telemetry-worker.ts. Main keeps
 * the lazy core (in-memory API) and each emit becomes a message over the
 * bridge (src/shared/telemetry-bridge.ts); the worker recreates the instruments with the
 * SAME names/descriptions and exports them — Prometheus names intact.
 *
 * Public API unchanged (counter/histogram/withSpan/init/stop) — callers
 * (capture/library/jev/ditado/annotations/agent) don't know about the worker.
 *
 * Env: OTEL_ENABLED (default 1) · OTEL_EXPORTER_OTLP_ENDPOINT (default :4318)
 * · VOICECAST_OTEL_DEBUG=1 (diag on worker stderr)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logError, logInfo } from "./logging";
import { createTelemetryCore, type MeterLike } from "../shared/telemetry-core";
import { createTelemetryBridge, type TelemetryBridge } from "../shared/telemetry-bridge";

const core = createTelemetryCore();

/** Lazy: resolve the instrument on first emit (see telemetry-core.ts). */
export const counter: typeof core.counter = core.counter;
export const histogram: typeof core.histogram = core.histogram;

/**
 * C4: plugs a meter INTO THE CURRENT PROCESS — the agent worker (utilityProcess)
 * uses this to relay counter/histogram from the runner to main over the port
 * (agent-worker-protocol.ts): the OTel SDK keeps existing only in the
 * main worker-thread (W1) — the utilityProcess does NOT duplicate the init. Main
 * never calls this (its meter is wired by initTelemetry).
 */
export function setProcessMeter(m: MeterLike | null): void {
  core.setMeter(m);
}

const bridge: TelemetryBridge = createTelemetryBridge({
  logger: { info: logInfo, error: logError },
  // ready (or late ready after timeout) wires the meter; going down unwires it.
  onReady: () => core.setMeter(bridge.meter),
  onDown: () => core.setMeter(null),
});

let started = false;

export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  await bridge.init(); // resolves on worker ready (or degraded) — never throws
}

/**
 * Worker flush+shutdown (the reader exports every 5s; without a flush, app.exit
 * loses the metrics of the current cycle). Call on will-quit and in smokes that
 * exit (--autotest/--transcribe) BEFORE app.exit.
 */
export async function stopTelemetry(): Promise<void> {
  await bridge.stop();
}

/** Stack of active spans in main: preserves the session.start → recorder.* hierarchy post-W1. */
const activeSpan = new AsyncLocalStorage<number | undefined>();
let spanSeq = 0;

/** Span for async blocks: const r = await withSpan("ditado.toggle", async (s) => {...}) */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!bridge.isUp()) return fn(); // no worker ready: no span (like without a tracer before)
  const id = ++spanSeq;
  const parent = activeSpan.getStore();
  bridge.post({ type: "span-start", id, parent, name, attrs, startMs: Date.now() });
  let error: string | undefined;
  try {
    return await activeSpan.run(id, fn);
  } catch (e) {
    error = (e as Error)?.stack ?? String(e);
    throw e;
  } finally {
    bridge.post({ type: "span-end", id, endMs: Date.now(), error });
  }
}
