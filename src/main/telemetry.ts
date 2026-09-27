/**
 * Telemetria OTel do voicecast — paridade com voice/telemetry.py (v2).
 * Métricas + traces via OTLP-HTTP para o collector local (:4318, stack
 * observability do unidocs). Degradação graciosa: collector fora → nada quebra.
 *
 * W1: o SDK OTel inteiro (import ~9s que travava o event loop do main) subiu
 * para um worker_threads — src/shared/telemetry-worker.ts. O main continua
 * com o core lazy (API in-memory) e cada emit vira mensagem pela ponte
 * (src/shared/telemetry-bridge.ts); o worker recria os instruments com os
 * MESMOS nomes/descrições e exporta — nomes Prometheus intactos.
 *
 * API pública inalterada (counter/histogram/withSpan/init/stop) — os callers
 * (capture/library/jev/ditado/annotations/agent) não conhecem o worker.
 *
 * Env: OTEL_ENABLED (default 1) · OTEL_EXPORTER_OTLP_ENDPOINT (default :4318)
 * · VOICECAST_OTEL_DEBUG=1 (diag no stderr do worker)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logError, logInfo } from "./logging";
import { createTelemetryCore } from "../shared/telemetry-core";
import { createTelemetryBridge, type TelemetryBridge } from "../shared/telemetry-bridge";

const core = createTelemetryCore();

/** Lazy: resolvem o instrumento no primeiro emit (ver telemetry-core.ts). */
export const counter: typeof core.counter = core.counter;
export const histogram: typeof core.histogram = core.histogram;

const bridge: TelemetryBridge = createTelemetryBridge({
  logger: { info: logInfo, error: logError },
  // ready (ou ready tardio pós-timeout) liga o meter; queda desliga.
  onReady: () => core.setMeter(bridge.meter),
  onDown: () => core.setMeter(null),
});

let started = false;

export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  await bridge.init(); // resolve no ready do worker (ou degradado) — nunca lança
}

/**
 * Flush+shutdown do worker (o reader exporta a cada 5s; sem flush o app.exit
 * perde as métricas do ciclo corrente). Chamar no will-quit e nos smokes que
 * saem (--autotest/--transcribe) ANTES do app.exit.
 */
export async function stopTelemetry(): Promise<void> {
  await bridge.stop();
}

/** Pilha de spans ativos no main: preserva a hierarquia session.start → recorder.* pós-W1. */
const activeSpan = new AsyncLocalStorage<number | undefined>();
let spanSeq = 0;

/** Span para blocos async: const r = await withSpan("ditado.toggle", async (s) => {...}) */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!bridge.isUp()) return fn(); // sem worker pronto: sem span (como sem tracer antes)
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
