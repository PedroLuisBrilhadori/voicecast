/**
 * Ponte main → worker de telemetria (W1). Spawn do worker, lifecycle por
 * mensagens e o meter-ponte que o main usa no core lazy: cada emit vira uma
 * mensagem (src/shared/telemetry-protocol.ts). Puro Node — sem electron —
 * para ser unit-testável (o logging vem injetado).
 *
 * Semânticas preservadas do desenho antigo (SDK no main):
 * - OTEL_ENABLED=0 → nada sobe (log "telemetria desligada");
 * - init resolve no ready do worker (ou degrada com log, nunca lança);
 * - emits antes do ready são descartados (core do main sem meter);
 * - stop = shutdown com flush (aguarda shutdown-done, termina por timeout).
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { MeterLike } from "./telemetry-core";
import type {
  TelemetryWorkerInbound,
  TelemetryWorkerOutbound,
} from "./telemetry-protocol";

export interface TelemetryBridgeLogger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface TelemetryBridgeOpts {
  /** Default: sibling compilado (dist/shared/telemetry-worker.js). Testes passam caminho próprio. */
  workerPath?: string;
  logger?: TelemetryBridgeLogger;
  /** Callbacks de lifecycle — o main liga/desliga o meter do core lazy neles. */
  onReady?: (endpoint: string) => void;
  onDown?: (reason: string) => void;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface TelemetryBridge {
  /** Spawn + init; resolve no ready, timeout ou falha — NUNCA rejeita. */
  init(): Promise<void>;
  /** Shutdown com flush; resolve no shutdown-done (ou termina por timeout). NUNCA rejeita. */
  stop(): Promise<void>;
  /** Meter-ponte: core do main resolve instruments nele no primeiro emit. */
  meter: MeterLike;
  /** Envia mensagem crua ao worker (spans do withSpan). No-throw. */
  post(msg: TelemetryWorkerInbound): void;
  /** Worker spawnado, pronto e não parado — gates spans/emits "vivos". */
  isUp(): boolean;
}

export function createTelemetryBridge(opts: TelemetryBridgeOpts = {}): TelemetryBridge {
  const logger = opts.logger ?? console;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 10_000;

  let worker: Worker | null = null;
  let ready = false;
  let stopped = false;
  let initPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let resolveInit: (() => void) | null = null;
  let resolveStop: (() => void) | null = null;

  const post = (msg: TelemetryWorkerInbound): void => {
    try {
      worker?.postMessage(msg);
    } catch {}
  };

  const meter: MeterLike = {
    createCounter: (name, o) => ({
      add: (n, attrs) => post({ type: "counter", name, description: o.description, n, attrs }),
    }),
    createHistogram: (name, o) => ({
      record: (n, attrs) => post({ type: "histogram", name, description: o.description, n, attrs }),
    }),
  };

  const finishInit = (): void => {
    const r = resolveInit;
    resolveInit = null;
    r?.();
  };
  const finishStop = (): void => {
    const r = resolveStop;
    resolveStop = null;
    r?.();
  };

  function handleOutbound(m: TelemetryWorkerOutbound): void {
    switch (m.type) {
      case "ready":
        ready = true;
        logger.info("telemetria: worker pronto — OTLP para", m.endpoint);
        opts.onReady?.(m.endpoint);
        finishInit();
        return;
      case "disabled":
        logger.error("telemetria desligada (OTEL_ENABLED=0, reportado pelo worker)");
        opts.onDown?.("disabled");
        finishInit();
        return;
      case "error":
        logger.error("telemetria: worker reportou erro:", m.message);
        opts.onDown?.("error");
        finishInit();
        return;
      case "shutdown-done":
        finishStop();
        return;
    }
  }

  function workerFile(): string | null {
    const p = opts.workerPath ?? path.join(__dirname, "telemetry-worker.js");
    return fs.existsSync(p) ? p : null;
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = new Promise<void>((res) => {
      resolveInit = res;
    });

    if (process.env.OTEL_ENABLED === "0") {
      logger.error("telemetria desligada (OTEL_ENABLED=0)");
      opts.onDown?.("disabled");
      finishInit();
      return initPromise;
    }

    const file = workerFile();
    if (!file) {
      logger.error("telemetria: worker não encontrado (build ausente?) — seguindo sem ela");
      opts.onDown?.("worker-missing");
      finishInit();
      return initPromise;
    }

    worker = new Worker(file);
    worker.on("message", handleOutbound);
    worker.on("error", (e) => {
      logger.error("telemetria: worker com erro:", (e as Error)?.message ?? String(e));
      opts.onDown?.("worker-error");
      ready = false;
      finishInit();
    });
    worker.on("exit", (code) => {
      if (!stopped && ready) {
        logger.error(`telemetria: worker saiu (code=${code}) — seguindo sem ela`);
        opts.onDown?.("exit");
      }
      ready = false;
      finishInit();
      finishStop(); // worker morreu no meio do stop: não esperar o timeout
    });

    logger.info("telemetria: spawn do worker (SDK OTel fora do main)");
    post({ type: "init" });

    // Init não pode prender quem await: se o import pesado demorar além do
    // timeout, segue degradado — se o worker ficar ready depois, onReady
    // ainda liga o meter (emits passam a fluir na hora).
    const timer = setTimeout(() => {
      if (resolveInit) {
        logger.error(`telemetria: worker não ficou pronto em ${readyTimeoutMs}ms — seguindo degradado`);
        finishInit();
      }
    }, readyTimeoutMs);
    timer.unref?.();
    return initPromise;
  }

  async function stop(): Promise<void> {
    if (!worker || stopped) {
      return;
    }
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = new Promise<void>((res) => {
      resolveStop = res;
    });

    post({ type: "shutdown" });
    const timer = setTimeout(() => {
      if (resolveStop) {
        logger.error(`telemetria: shutdown-done não chegou em ${stopTimeoutMs}ms — terminando worker`);
        finishStop();
      }
    }, stopTimeoutMs);
    timer.unref?.();
    await stopPromise;
    clearTimeout(timer);
    void worker.terminate(); // pós-flush (ou timeout): garante o fim
    worker = null;
    ready = false;
  }

  return {
    init,
    stop,
    meter,
    post,
    isUp: () => worker !== null && ready && !stopped,
  };
}
