/**
 * Telemetria OTel do voicecast — paridade com voice/telemetry.py (v2).
 * Métricas + traces via OTLP-HTTP para o collector local (:4318, stack
 * observability do unidocs). Degradação graciosa: collector fora → nada quebra.
 *
 * Os counters/histogramas são declarados no module-load, ANTES do init (que é
 * 3s pós-ready) — por isso vêm do core lazy (src/shared/telemetry-core.ts),
 * que resolve o instrumento no primeiro add/record com o meter pós-init.
 *
 * Env: OTEL_ENABLED (default 1) · OTEL_EXPORTER_OTLP_ENDPOINT (default :4318)
 */
import { logError, logInfo } from "./logging";
import { createTelemetryCore } from "../shared/telemetry-core";

const core = createTelemetryCore();

/** Lazy: resolvem o instrumento no primeiro emit (ver telemetry-core.ts). */
export const counter: typeof core.counter = core.counter;
export const histogram: typeof core.histogram = core.histogram;

let tracer: import("@opentelemetry/api").Tracer | null = null;
let started = false;
let sdk: import("@opentelemetry/sdk-node").NodeSDK | null = null;

export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  if (process.env.OTEL_ENABLED === "0") {
    logError("telemetria desligada (OTEL_ENABLED=0)");
    return;
  }
  try {
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
    sdk = new NodeSDK({
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
    core.setMeter(api.metrics.getMeter("voicecast"));
    tracer = api.trace.getTracer("voicecast");
    logInfo("telemetria: OTLP para", endpoint);
  } catch (e) {
    logError("telemetria indisponível (seguindo sem ela):", (e as Error)?.message ?? e);
    core.setMeter(null);
    tracer = null;
    sdk = null;
  }
}

/**
 * Flush+shutdown do SDK — sem isso o app.exit() perde as métricas do ciclo
 * corrente (o reader só exporta no intervalo). Chamar no will-quit e nos
 * smokes que saem (--autotest/--transcribe) ANTES do app.exit.
 */
export async function stopTelemetry(): Promise<void> {
  const s = sdk;
  sdk = null;
  if (!s) return;
  try {
    await s.shutdown();
  } catch {}
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
