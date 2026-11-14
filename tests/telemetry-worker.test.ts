/**
 * W1 — OTel telemetry worker.
 *
 * Coverage: (1) worker logic (protocol, boot counter, spans with
 * hierarchy, shutdown with flush) with an injected SDK; (2) main bridge
 * (kill-switch, degradation, messages on a real thread); (3) init doesn't block
 * the main event loop (heavy SDK simulated in the worker — the W1 bug);
 * (4) REAL compiled worker: boots, imports the real SDK and reports ready.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import type { Attributes, MeterLike } from "../src/shared/telemetry-core";
import {
  runTelemetryWorker,
  type SpanLike,
  type TelemetrySdkHandle,
  type TracerLike,
} from "../src/shared/telemetry-worker";
import type {
  TelemetryWorkerInbound,
  TelemetryWorkerOutbound,
} from "../src/shared/telemetry-protocol";
import { createTelemetryBridge, type TelemetryBridgeLogger } from "../src/shared/telemetry-bridge";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------- fakes

type Port = ReturnType<typeof fakePort>;

function fakePort() {
  const outbox: TelemetryWorkerOutbound[] = [];
  const listeners: ((m: TelemetryWorkerInbound) => void)[] = [];
  return {
    outbox,
    on(_ev: "message", cb: (m: TelemetryWorkerInbound) => void): void {
      listeners.push(cb);
    },
    postMessage(m: TelemetryWorkerOutbound): void {
      outbox.push(m);
    },
    send(m: TelemetryWorkerInbound): void {
      for (const cb of listeners) cb(m);
    },
  };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for worker condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeMeter() {
  const created: string[] = [];
  const added: { name: string; n: number; attrs?: Attributes }[] = [];
  const recorded: { name: string; n: number; attrs?: Attributes }[] = [];
  const meter: MeterLike = {
    createCounter: (name) => {
      created.push(name);
      return { add: (n, attrs) => added.push({ name, n, attrs }) };
    },
    createHistogram: (name) => {
      created.push(name);
      return { record: (n, attrs) => recorded.push({ name, n, attrs }) };
    },
  };
  return { meter, created, added, recorded };
}

function fakeTracer() {
  const spans: {
    name: string;
    attrs?: Attributes;
    startTime?: number;
    endTime?: number;
    parent?: SpanLike;
    errors: unknown[];
  }[] = [];
  const tracer: TracerLike = {
    startSpan: (name, opts, parent) => {
      const s = {
        name,
        attrs: opts.attributes,
        startTime: opts.startTime,
        parent,
        errors: [] as unknown[],
        endTime: undefined as number | undefined,
        // the record itself IS the returned span — identity preserves parent/child
        recordException: (e: unknown) => {
          s.errors.push(e);
        },
        end: (endTime?: number) => {
          s.endTime = endTime;
        },
      };
      spans.push(s);
      return s;
    },
  };
  return { tracer, spans: spans as (SpanLike & { name: string })[] };
}

function fakeHandle(meter: MeterLike, tracer: TracerLike | null, onShutdown: () => void): () => Promise<TelemetrySdkHandle> {
  return async () => ({
    endpoint: "http://fake:4318",
    meter,
    tracer,
    shutdown: async () => {
      onShutdown();
    },
  });
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Captures bridge logger calls (the real one goes to main.log via logging.ts). */
function spyLogger(): TelemetryBridgeLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}

/** Spy worker in plain JS (real thread) that speaks the minimal protocol. */
function writeSpyWorker(dir: string, logFile: string): string {
  const file = path.join(dir, `spy-worker-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(
    file,
    `
const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");
const log = (s) => fs.appendFileSync(${JSON.stringify(logFile)}, s + "\\n");
parentPort.on("message", (m) => {
  if (m.type === "init") { log("init"); parentPort.postMessage({ type: "ready", endpoint: "http://spy:4318" }); }
  else if (m.type === "counter" || m.type === "histogram") { log(m.type + ":" + m.name); }
  else if (m.type === "span-start") { log("span:" + m.name); }
  else if (m.type === "shutdown") { log("shutdown"); parentPort.postMessage({ type: "shutdown-done" }); }
});
`,
  );
  return file;
}

/** Builds the REAL worker (TS → JS) where the @opentelemetry/* requires resolve. */
async function buildRealWorkerJs(): Promise<string> {
  const dir = path.join(REPO_ROOT, "node_modules", ".voicecast-vitest");
  fs.mkdirSync(dir, { recursive: true });
  const outfile = path.join(dir, "telemetry-worker.js");
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, "src", "shared", "telemetry-worker.ts")],
    outfile,
    bundle: true,
    packages: "external",
    format: "cjs",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    sourcemap: false,
  });
  return outfile;
}

// ---------------------------------------------------------------- worker (logic)

describe("telemetry-worker (protocol, injected SDK)", () => {
  it("init → ready + boot counter (telemetry about telemetry)", async () => {
    const port = fakePort();
    const m = fakeMeter();
    const t = fakeTracer();
    let shutdowns = 0;
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, t.tracer, () => shutdowns++) });

    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    expect(port.outbox).toEqual([{ type: "ready", endpoint: "http://fake:4318" }]);
    expect(m.created).toEqual(["voicecast_telemetry_worker_started_total"]);
    expect(m.added).toEqual([{ name: "voicecast_telemetry_worker_started_total", n: 1, attrs: undefined }]);
  });

  it("counter/histogram preserve name/description/value/attrs; repeated name = 1 instrument", async () => {
    const port = fakePort();
    const m = fakeMeter();
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, null, () => {}) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    port.send({ type: "counter", name: "voicecast_sessions_total", description: "sessões finalizadas por modo", n: 1, attrs: { mode: "screen" } });
    port.send({ type: "counter", name: "voicecast_sessions_total", description: "sessões finalizadas por modo", n: 1, attrs: { mode: "window" } });
    port.send({ type: "histogram", name: "voicecast_session_start_seconds", description: "duração do início de sessão", n: 2.5, attrs: { mode: "screen", stage: "total" } });

    // Prometheus names intact + dedupe by name (same lazy core as before);
    // the worker's own boot counter also goes through the same path
    expect(m.created).toEqual([
      "voicecast_telemetry_worker_started_total",
      "voicecast_sessions_total",
      "voicecast_session_start_seconds",
    ]);
    expect(m.added).toEqual([
      { name: "voicecast_telemetry_worker_started_total", n: 1, attrs: undefined },
      { name: "voicecast_sessions_total", n: 1, attrs: { mode: "screen" } },
      { name: "voicecast_sessions_total", n: 1, attrs: { mode: "window" } },
    ]);
    expect(m.recorded).toEqual([
      { name: "voicecast_session_start_seconds", n: 2.5, attrs: { mode: "screen", stage: "total" } },
    ]);
  });

  it("span-start/end recreate hierarchy (parent/child), timing and error", async () => {
    const port = fakePort();
    const m = fakeMeter();
    const t = fakeTracer();
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, t.tracer as unknown as TracerLike, () => {}) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    // real pattern from capture.ts: session.start { recorder.load, recorder.open }
    port.send({ type: "span-start", id: 1, name: "session.start", attrs: { mode: "screen" }, startMs: 1000 });
    port.send({ type: "span-start", id: 2, parent: 1, name: "recorder.open", attrs: {}, startMs: 1100 });
    port.send({ type: "span-end", id: 2, endMs: 1200 });
    port.send({ type: "span-end", id: 1, endMs: 1500, error: "boom stack" });
    port.send({ type: "span-end", id: 99, endMs: 1600 }); // unknown → no-op

    expect(t.spans).toHaveLength(2);
    const [parent, child] = t.spans;
    expect(parent.name).toBe("session.start");
    expect(parent.startTime).toBe(1000);
    expect(parent.endTime).toBe(1500);
    expect(parent.errors).toEqual(["boom stack"]);
    expect(child.name).toBe("recorder.open");
    expect(child.parent).toBe(parent); // hierarchy preserved post-worker
    expect(child.startTime).toBe(1100);
    expect(child.endTime).toBe(1200);
  });

  it("emits before init are dropped without throwing (lazy core semantics)", () => {
    const port = fakePort();
    const m = fakeMeter();
    const t = fakeTracer();
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, t.tracer, () => {}) });

    expect(() => {
      port.send({ type: "counter", name: "x_total", description: "d", n: 1 });
      port.send({ type: "span-start", id: 1, name: "early", attrs: {}, startMs: 1 });
      port.send({ type: "span-end", id: 1, endMs: 2 });
    }).not.toThrow();
    expect(m.created).toEqual([]);
    expect(t.spans).toHaveLength(0);
  });

  it("shutdown → flush (sdk.shutdown) + shutdown-done; repeated one responds", async () => {
    const port = fakePort();
    const m = fakeMeter();
    let shutdowns = 0;
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, null, () => shutdowns++) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    port.send({ type: "shutdown" });
    await until(() => port.outbox.some((x) => x.type === "shutdown-done"));
    expect(shutdowns).toBe(1);

    port.send({ type: "shutdown" }); // no handle: responds directly
    await until(() => port.outbox.filter((x) => x.type === "shutdown-done").length === 2);
    expect(shutdowns).toBe(1);
  });

  it("OTEL_ENABLED=0 → disabled without touching the SDK", async () => {
    const prev = process.env.OTEL_ENABLED;
    process.env.OTEL_ENABLED = "0";
    try {
      const port = fakePort();
      let called = 0;
      runTelemetryWorker(port, {
        initSdk: async () => {
          called++;
          throw new Error("SDK should not have been imported");
        },
      });
      port.send({ type: "init" });
      await until(() => port.outbox.length > 0);
      expect(port.outbox).toEqual([{ type: "disabled" }]);
      expect(called).toBe(0);
    } finally {
      setEnv("OTEL_ENABLED", prev);
    }
  });
});

// ---------------------------------------------------------------- bridge (main)

describe("telemetry-bridge (spawn/lifecycle in main)", () => {
  it("OTEL_ENABLED=0 → kill-switch: doesn't boot the worker, resolves degraded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-bridge-"));
    const logFile = path.join(dir, "worker.log");
    const logger = spyLogger();
    const bridge = createTelemetryBridge({
      workerPath: writeSpyWorker(dir, logFile),
      logger,
    });
    const prev = process.env.OTEL_ENABLED;
    process.env.OTEL_ENABLED = "0";
    try {
      await expect(bridge.init()).resolves.toBeUndefined();
      expect(bridge.isUp()).toBe(false);
      expect(logger.lines.join("\n")).toContain("telemetry disabled");
    } finally {
      setEnv("OTEL_ENABLED", prev);
    }
    // proof that it did NOT spawn: the spy worker never received init
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("missing workerPath → degrades with a log, without throwing", async () => {
    const logger = spyLogger();
    const bridge = createTelemetryBridge({
      workerPath: path.join(os.tmpdir(), "telemetry-worker-que-nao-existe.js"),
      logger,
    });
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.isUp()).toBe(false);
    expect(logger.lines.join("\n")).toContain("worker not found");
    await bridge.stop(); // safe no-op
  });

  it("bridge-meter emits reach the worker (real thread) and stop shuts down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-bridge-"));
    const logFile = path.join(dir, "worker.log");
    const logger = spyLogger();
    const bridge = createTelemetryBridge({ workerPath: writeSpyWorker(dir, logFile), logger });

    await bridge.init();
    expect(bridge.isUp()).toBe(true);
    expect(logger.lines.join("\n")).toContain("worker ready — OTLP to http://spy:4318");

    // real callers path: lazy core resolves the instrument on the first emit
    bridge.meter.createCounter("voicecast_sessions_total", { description: "sessões" }).add(1, { mode: "screen" });
    bridge.meter.createHistogram("voicecast_finalize_seconds", { description: "finalize" }).record(0.4);
    bridge.post({ type: "span-start", id: 1, name: "session.start", attrs: {}, startMs: Date.now() });
    bridge.post({ type: "span-end", id: 1, endMs: Date.now() });

    await until(() => {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      return log.includes("counter:voicecast_sessions_total") && log.includes("histogram:voicecast_finalize_seconds") && log.includes("span:session.start");
    });

    await bridge.stop();
    expect(bridge.isUp()).toBe(false);
    await until(() => fs.readFileSync(logFile, "utf8").includes("shutdown"));
  }, 15_000);

  it("init does NOT block the main event loop (heavy SDK simulated in the worker)", async () => {
    // the W1 bug: the SDK import (~9s) froze the main. Here the worker burns
    // 500ms of ITS OWN CPU before ready; main timers have to stay
    // punctual — if anyone moves init back to the main thread, this test fails.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-heavy-"));
    const file = path.join(dir, "heavy-worker.js");
    fs.writeFileSync(
      file,
      `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  if (m.type === "init") {
    const t0 = Date.now();
    while (Date.now() - t0 < 500) {} // simulates the SDK import freezing ONLY the worker
    parentPort.postMessage({ type: "ready", endpoint: "http://heavy:4318" });
  } else if (m.type === "shutdown") {
    parentPort.postMessage({ type: "shutdown-done" });
  }
});
`,
    );

    const bridge = createTelemetryBridge({ workerPath: file, readyTimeoutMs: 10_000 });
    const t0 = Date.now();
    const fires: number[] = [];
    const timer = setInterval(() => fires.push(Date.now()), 25);

    await bridge.init();
    clearInterval(timer);

    expect(bridge.isUp()).toBe(true);
    expect(fires.length).toBeGreaterThanOrEqual(18); // ~450ms of ticks during the worker burn
    let worst = 0;
    for (let i = 0; i < fires.length; i++) {
      worst = Math.max(worst, fires[i] - (t0 + (i + 1) * 25));
    }
    expect(worst).toBeLessThan(150); // init blocking the main → ~500ms drift
    await bridge.stop();
  }, 20_000);
});

// ---------------------------------------------------------------- real worker

describe("telemetry-worker (REAL: the actual OTel SDK inside the worker)", () => {
  it("boots, imports the SDK and reports ready; stop flushes and exits", async () => {
    const workerJs = await buildRealWorkerJs();
    const logger = spyLogger();
    const bridge = createTelemetryBridge({
      workerPath: workerJs,
      logger,
      readyTimeoutMs: 60_000, // sdk-node import: ~9s cold start measured on Windows
      stopTimeoutMs: 20_000,
    });
    const prev = process.env.OTEL_ENABLED;
    process.env.OTEL_ENABLED = "1";
    try {
      await bridge.init();
      expect(bridge.isUp()).toBe(true);
      expect(logger.lines.join("\n")).toContain("worker ready — OTLP to");
      // one emit crosses the real bridge (main core → worker → SDK) without throwing
      expect(() =>
        bridge.meter.createCounter("voicecast_sessions_total", { description: "smoke w1" }).add(1, { mode: "screen" }),
      ).not.toThrow();
      await bridge.stop();
      expect(bridge.isUp()).toBe(false);
    } finally {
      setEnv("OTEL_ENABLED", prev);
    }
  }, 120_000);
});
