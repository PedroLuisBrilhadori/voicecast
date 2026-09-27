/**
 * Worker de telemetria OTel (W1) — TODO o SDK vive AQUI, nunca no main.
 *
 * Por quê: o import do SDK trava o event loop por ~9s (RELATORIO-TELEMETRIA,
 * causa 2 do delay do REC). Neste worker o import/init bloqueia só este
 * thread; o main segue livre e manda os emits como mensagens
 * (src/shared/telemetry-protocol.ts). O core lazy é o MESMO
 * (telemetry-core.ts) — os instruments nascem com os mesmos nomes/descrições
 * que chegam nas mensagens, então os nomes Prometheus não mudam.
 *
 * Arquivo puro de Node (sem electron — logging.ts puxaria o `app`): o que o
 * main precisa saber (lifecycle/erros) vem por mensagens; diag
 * VOICECAST_OTEL_DEBUG fala no stderr deste worker.
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

/** Fatia do Tracer OTel usada pelo worker (estrutural — fake encaixa). */
export interface SpanLike {
  recordException(e: unknown): void;
  end(endTime?: number): void;
}

export interface TracerLike {
  /** startTime/endTime em epoch-ms (TimeInput do OTel aceita Date.now()). */
  startSpan(
    name: string,
    opts: { startTime?: number; attributes?: Attributes },
    parent?: SpanLike,
  ): SpanLike;
}

/** SDK já iniciado no worker — o que o main nunca enxerga direto. */
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
  /** Injetável para testes (default: SDK OTel de verdade). Nunca deve lançar — erro vira message. */
  initSdk?: () => Promise<TelemetrySdkHandle>;
}

const BOOT_COUNTER = "voicecast_telemetry_worker_started_total";

/**
 * Init REAL do SDK (ex-init do telemetry.ts do main, movido 1:1 — mesma
 * config de exporter/reader, mesmos envs). Dinâmico: o import pesado só
 * acontece no `init`, dentro deste thread.
 */
async function initRealSdk(): Promise<TelemetrySdkHandle> {
  const api = await import("@opentelemetry/api");
  if (process.env.VOICECAST_OTEL_DEBUG === "1") {
    // diag do OTel é silencioso por default — sem isso erros de export
    // (ex.: metric reader) desaparecem sem vestígios
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
    // plural (singular 'metricReader' é deprecado no sdk-node 0.222+)
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
 * Loop do worker: aplica as mensagens do main no SDK local. Emits chegam com
 * name/description e são aplicados no core lazy daqui — emit antes do ready é
 * descartado (mesma semântica de antes do init no desenho antigo).
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
    // Telemetria sobre a telemetria (DoD do W1): prova que o caminho novo
    // (worker → SDK → OTLP) está vivo — exportada no flush do shutdown.
    core.counter(BOOT_COUNTER, "boots do worker de telemetria OTel (caminho W1 ativo)").add(1);
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
        if (!handle?.tracer) return; // degradado: span descartado (como antes do init)
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
          .shutdown() // flush do reader (senão app.exit perde o ciclo corrente)
          .catch(() => {})
          .finally(() => post({ type: "shutdown-done" }));
        return;
      }
    }
  });
}

// Entrada real: `new Worker(dist/shared/telemetry-worker.js)` cai aqui.
// Importado no main thread (testes), parentPort é null → não liga nada.
if (!isMainThread && parentPort) {
  runTelemetryWorker(parentPort as MessagePort);
}
