/**
 * Telemetria OTel do voicecast — paridade com voice/telemetry.py (v2).
 * Métricas + traces via OTLP-HTTP para o collector local (:4318, stack
 * observability do unidocs). Degradação graciosa: collector fora → nada quebra.
 *
 * Env: OTEL_ENABLED (default 1) · OTEL_EXPORTER_OTLP_ENDPOINT (default :4318)
 */
import { logError, logInfo } from "./logging";

let meter: import("@opentelemetry/api").Meter | null = null;
let tracer: import("@opentelemetry/api").Tracer | null = null;
let started = false;

export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  if (process.env.OTEL_ENABLED === "0") {
    logError("telemetria desligada (OTEL_ENABLED=0)");
    return;
  }
  try {
    const api = await import("@opentelemetry/api");
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");

    const endpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
    const sdk = new NodeSDK({
      serviceName: "voicecast",
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
    });
    sdk.start();
    meter = api.metrics.getMeter("voicecast");
    tracer = api.trace.getTracer("voicecast");
    logInfo("telemetria: OTLP para", endpoint);
  } catch (e) {
    logError("telemetria indisponível (seguindo sem ela):", (e as Error)?.message ?? e);
    meter = null;
    tracer = null;
  }
}

/** Span para blocos async: const r = await withSpan("ditado.toggle", async (s) => {...}) */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn();
    } catch (e) {
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function counter(
  name: string,
  description: string,
): { add: (n: number, attrs?: Record<string, string>) => void } | null {
  if (!meter) return null;
  const c = meter.createCounter(name, { description });
  return { add: (n, attrs) => c.add(n, attrs) };
}

export function histogram(
  name: string,
  description: string,
): { record: (n: number, attrs?: Record<string, string>) => void } | null {
  if (!meter) return null;
  const h = meter.createHistogram(name, { description });
  return { record: (n, attrs) => h.record(n, attrs) };
}
