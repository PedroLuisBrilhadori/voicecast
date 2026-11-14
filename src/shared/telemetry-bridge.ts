/**
 * Telemetry main → worker bridge (W1). Worker spawn, message-driven
 * lifecycle and the meter-bridge main uses in the lazy core: each emit
 * becomes a message (src/shared/telemetry-protocol.ts). Pure Node — no
 * electron — so it is unit-testable (logging is injected).
 *
 * Semantics preserved from the old design (SDK in main):
 * - OTEL_ENABLED=0 → nothing comes up (log "telemetry disabled");
 * - init resolves on worker ready (or degrades with a log, never throws);
 * - emits before ready are discarded (main's core without a meter);
 * - stop = shutdown with flush (waits for shutdown-done, terminates on timeout).
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
  /** Default: compiled sibling (dist/shared/telemetry-worker.js). Tests pass their own path. */
  workerPath?: string;
  logger?: TelemetryBridgeLogger;
  /** Lifecycle callbacks — main attaches/detaches the lazy core's meter in them. */
  onReady?: (endpoint: string) => void;
  onDown?: (reason: string) => void;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface TelemetryBridge {
  /** Spawn + init; resolves on ready, timeout or failure — NEVER rejects. */
  init(): Promise<void>;
  /** Shutdown with flush; resolves on shutdown-done (or terminates on timeout). NEVER rejects. */
  stop(): Promise<void>;
  /** Bridge meter: main's core resolves instruments in it on the first emit. */
  meter: MeterLike;
  /** Sends a raw message to the worker (withSpan's spans). No-throw. */
  post(msg: TelemetryWorkerInbound): void;
  /** Worker spawned, ready and not stopped — gates "live" spans/emits. */
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
        logger.info("telemetry: worker ready — OTLP to", m.endpoint);
        opts.onReady?.(m.endpoint);
        finishInit();
        return;
      case "disabled":
        logger.error("telemetry disabled (OTEL_ENABLED=0, reported by the worker)");
        opts.onDown?.("disabled");
        finishInit();
        return;
      case "error":
        logger.error("telemetry: worker reported an error:", m.message);
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
      logger.error("telemetry disabled (OTEL_ENABLED=0)");
      opts.onDown?.("disabled");
      finishInit();
      return initPromise;
    }

    const file = workerFile();
    if (!file) {
      logger.error("telemetry: worker not found (missing build?) — continuing without it");
      opts.onDown?.("worker-missing");
      finishInit();
      return initPromise;
    }

    worker = new Worker(file);
    worker.on("message", handleOutbound);
    worker.on("error", (e) => {
      logger.error("telemetry: worker error:", (e as Error)?.message ?? String(e));
      opts.onDown?.("worker-error");
      ready = false;
      finishInit();
    });
    worker.on("exit", (code) => {
      if (!stopped && ready) {
        logger.error(`telemetry: worker exited (code=${code}) — continuing without it`);
        opts.onDown?.("exit");
      }
      ready = false;
      finishInit();
      finishStop(); // worker died mid-stop: don't wait for the timeout
    });

    logger.info("telemetry: worker spawn (OTel SDK out of main)");
    post({ type: "init" });

    // Init must not hold its awaiter: if the heavy import takes longer than
    // the timeout, continue degraded — if the worker becomes ready later,
    // onReady still attaches the meter (emits start flowing right away).
    const timer = setTimeout(() => {
      if (resolveInit) {
        logger.error(`telemetry: worker not ready within ${readyTimeoutMs}ms — continuing degraded`);
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
        logger.error(`telemetry: shutdown-done didn't arrive within ${stopTimeoutMs}ms — terminating worker`);
        finishStop();
      }
    }, stopTimeoutMs);
    timer.unref?.();
    await stopPromise;
    clearTimeout(timer);
    void worker.terminate(); // post-flush (or timeout): guarantees the end
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
