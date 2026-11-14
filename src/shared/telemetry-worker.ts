/**
 * OTel telemetry worker (W1) — the WHOLE SDK lives HERE, never in main.
 *
 * Why: the SDK import stalls the event loop for ~9s (RELATORIO-TELEMETRIA,
 * REC delay cause 2). In this worker the import/init blocks only this
 * thread; main stays free and sends the emits as messages
 * (src/shared/telemetry-protocol.ts). The lazy core is the SAME
 * (telemetry-core.ts) — instruments are born with the same names/descriptions
 * that arrive in the messages, so the Prometheus names don't change.
 *
 * Pure Node file (no electron — logging.ts would pull in `app`): whatever
 * main needs to know (lifecycle/errors) comes via messages; VOICECAST_OTEL_DEBUG
 * diag talks on this worker's stderr.
 *
 * Env: OTEL_ENABLED (default 1) · OTEL_EXPORTER_OTLP_ENDPOINT (default :4318)
 * · VOICECAST_OTEL_DEBUG=1
 */
import { parentPort, isMainThread, type MessagePort } from "node:worker_threads";
import { createTelemetryCore, type Attributes, type MeterLike } from "./telemetry-core";
import type {
  TelemetryWorkerInbound,
  TelemetryWorkerOutbound,
} from "./telemetry-protocol";

/** Slice of the OTel Tracer the worker uses (structural — a fake fits). */
export interface SpanLike {
  recordException(e: unknown): void;
  end(endTime?: number): void;
}

export interface TracerLike {
  /** startTime/endTime in epoch-ms (OTel's TimeInput accepts Date.now()). */
  startSpan(
    name: string,
    opts: { startTime?: number; attributes?: Attributes },
    parent?: SpanLike,
  ): SpanLike;
}

/** SDK already started in the worker — what main never sees directly. */
export interface TelemetrySdkHandle {
  endpoint: string;
  meter: MeterLike;
  tracer: TracerLike | null;
  shutdown(): Promise<void>;
}

export type TelemetryWorkerPort = {
  on(event: "message", cb: (m: TelemetryWorkerInbound) => void): unknown;
  postMessage(m: TelemetryWorkerOutbound): void;
};

export interface TelemetryWorkerDeps {
  /** Injectable for tests (default: the real OTel SDK). Must never throw — errors become messages. */
  initSdk?: () => Promise<TelemetrySdkHandle>;
}

const BOOT_COUNTER = "voicecast_telemetry_worker_started_total";

/**
 * REAL SDK init (former init of main's telemetry.ts, moved 1:1 — same
 * exporter/reader config, same envs). Dynamic: the heavy import only happens
 * in `init`, inside this thread.
 */
async function initRealSdk(): Promise<TelemetrySdkHandle> {
  const api = await import("@opentelemetry/api");
  if (process.env.VOICECAST_OTEL_DEBUG === "1") {
    // OTel's diag is silent by default — without this export errors
    // (e.g. metric reader) vanish without a trace
    api.diag.setLogger(new api.DiagConsoleLogger(), api.DiagLogLevel.DEBUG);
  }
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
  const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const sdk = new NodeSDK({
    serviceName: "voicecast",
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    // plural (singular 'metricReader' is deprecated in sdk-node 0.222+)
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 5_000,
      }),
    ],
  });
  sdk.start();

  const tracer = api.trace.getTracer("voicecast");
  return {
    endpoint,
    meter: api.metrics.getMeter("voicecast"),
    tracer: {
      startSpan: (name, opts, parentSpan) => {
        const ctx = parentSpan
          ? api.trace.setSpan(api.context.active(), parentSpan as Parameters<typeof api.trace.setSpan>[1])
          : api.context.active();
        return tracer.startSpan(
          name,
          { startTime: opts.startTime, attributes: opts.attributes },
          ctx,
        );
      },
    },
    shutdown: () => sdk.shutdown(),
  };
}

/**
 * Worker loop: applies main's messages to the local SDK. Emits arrive with
 * name/description and are applied to this side's lazy core — emit before
 * ready is discarded (same semantics as before-init in the old design).
 */
export function runTelemetryWorker(port: TelemetryWorkerPort, deps?: TelemetryWorkerDeps): void {
  const core = createTelemetryCore();
  let handle: TelemetrySdkHandle | null = null;
  const spans = new Map<number, SpanLike>();

  const post = (m: TelemetryWorkerOutbound): void => {
    try {
      port.postMessage(m);
    } catch {}
  };

  const init = async (): Promise<void> => {
    if (process.env.OTEL_ENABLED === "0") {
      post({ type: "disabled" });
      return;
    }
    try {
      handle = deps?.initSdk ? await deps.initSdk() : await initRealSdk();
    } catch (e) {
      handle = null;
      post({ type: "error", message: (e as Error)?.message ?? String(e) });
      return;
    }
    core.setMeter(handle.meter);
    // Telemetry about telemetry (W1's DoD): proves the new path
    // (worker → SDK → OTLP) is alive — exported on shutdown flush.
    core.counter(BOOT_COUNTER, "OTel telemetry worker boots (W1 path active)").add(1);
    post({ type: "ready", endpoint: handle.endpoint });
  };

  port.on("message", (m: TelemetryWorkerInbound) => {
    switch (m.type) {
      case "init":
        void init();
        return;
      case "counter":
        core.counter(m.name, m.description).add(m.n, m.attrs);
        return;
      case "histogram":
        core.histogram(m.name, m.description).record(m.n, m.attrs);
        return;
      case "span-start": {
        if (!handle?.tracer) return; // degraded: span discarded (as before init)
        const parent = m.parent !== undefined ? spans.get(m.parent) : undefined;
        const span = handle.tracer.startSpan(m.name, {
          startTime: m.startMs,
          attributes: m.attrs,
        }, parent);
        spans.set(m.id, span);
        return;
      }
      case "span-end": {
        const span = spans.get(m.id);
        if (!span) return;
        spans.delete(m.id);
        if (m.error) span.recordException(m.error);
        span.end(m.endMs);
        return;
      }
      case "shutdown": {
        const h = handle;
        handle = null;
        spans.clear();
        if (!h) {
          post({ type: "shutdown-done" });
          return;
        }
        void h
          .shutdown() // reader flush (otherwise app.exit loses the current cycle)
          .catch(() => {})
          .finally(() => post({ type: "shutdown-done" }));
        return;
      }
    }
  });
}

// Real entry: `new Worker(dist/shared/telemetry-worker.js)` lands here.
// Imported in the main thread (tests), parentPort is null → wires up nothing.
if (!isMainThread && parentPort) {
  runTelemetryWorker(parentPort as MessagePort);
}
