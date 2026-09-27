/**
 * W1 — worker de telemetria OTel.
 *
 * Cobertura: (1) lógica do worker (protocolo, boot counter, spans com
 * hierarquia, shutdown com flush) com SDK injetado; (2) ponte do main
 * (kill-switch, degradação, mensagens em thread real); (3) init não bloqueia
 * o event loop do main (SDK pesado simulado no worker — o bug do W1);
 * (4) worker REAL compilado: sobe, importa o SDK de verdade e reporta pronto.
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
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condição do worker");
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
        // o próprio registro É o span retornado — identidade preserva pai/filho
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

/** Captura chamadas do logger da ponte (a real vai pro main.log via logging.ts). */
function spyLogger(): TelemetryBridgeLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}

/** Worker espião em JS puro (thread de verdade) que fala o protocolo mínimo. */
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

/** Compila o worker REAL (TS → JS) onde os requires de @opentelemetry/* resolvem. */
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

// ---------------------------------------------------------------- worker (lógica)

describe("telemetry-worker (protocolo, SDK injetado)", () => {
  it("init → ready + counter de boot (telemetria sobre a telemetria)", async () => {
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

  it("counter/histogram preservam nome/descrição/valor/attrs; nome repetido = 1 instrumento", async () => {
    const port = fakePort();
    const m = fakeMeter();
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, null, () => {}) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    port.send({ type: "counter", name: "voicecast_sessions_total", description: "sessões finalizadas por modo", n: 1, attrs: { mode: "screen" } });
    port.send({ type: "counter", name: "voicecast_sessions_total", description: "sessões finalizadas por modo", n: 1, attrs: { mode: "window" } });
    port.send({ type: "histogram", name: "voicecast_session_start_seconds", description: "duração do início de sessão", n: 2.5, attrs: { mode: "screen", stage: "total" } });

    // nomes Prometheus intactos + dedupe por nome (mesmo core lazy de antes);
    // o boot counter do próprio worker também passa pelo mesmo caminho
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

  it("span-start/end recriam hierarquia (pai/filho), timing e erro", async () => {
    const port = fakePort();
    const m = fakeMeter();
    const t = fakeTracer();
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, t.tracer as unknown as TracerLike, () => {}) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    // padrão real do capture.ts: session.start { recorder.load, recorder.open }
    port.send({ type: "span-start", id: 1, name: "session.start", attrs: { mode: "screen" }, startMs: 1000 });
    port.send({ type: "span-start", id: 2, parent: 1, name: "recorder.open", attrs: {}, startMs: 1100 });
    port.send({ type: "span-end", id: 2, endMs: 1200 });
    port.send({ type: "span-end", id: 1, endMs: 1500, error: "boom stack" });
    port.send({ type: "span-end", id: 99, endMs: 1600 }); // desconhecido → no-op

    expect(t.spans).toHaveLength(2);
    const [parent, child] = t.spans;
    expect(parent.name).toBe("session.start");
    expect(parent.startTime).toBe(1000);
    expect(parent.endTime).toBe(1500);
    expect(parent.errors).toEqual(["boom stack"]);
    expect(child.name).toBe("recorder.open");
    expect(child.parent).toBe(parent); // hierarquia preservada pós-worker
    expect(child.startTime).toBe(1100);
    expect(child.endTime).toBe(1200);
  });

  it("emits antes do init são descartados sem lançar (semântica do core lazy)", () => {
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

  it("shutdown → flush (sdk.shutdown) + shutdown-done; repetido responde", async () => {
    const port = fakePort();
    const m = fakeMeter();
    let shutdowns = 0;
    runTelemetryWorker(port, { initSdk: fakeHandle(m.meter, null, () => shutdowns++) });
    port.send({ type: "init" });
    await until(() => port.outbox.some((x) => x.type === "ready"));

    port.send({ type: "shutdown" });
    await until(() => port.outbox.some((x) => x.type === "shutdown-done"));
    expect(shutdowns).toBe(1);

    port.send({ type: "shutdown" }); // sem handle: responde direto
    await until(() => port.outbox.filter((x) => x.type === "shutdown-done").length === 2);
    expect(shutdowns).toBe(1);
  });

  it("OTEL_ENABLED=0 → disabled sem tocar o SDK", async () => {
    const prev = process.env.OTEL_ENABLED;
    process.env.OTEL_ENABLED = "0";
    try {
      const port = fakePort();
      let called = 0;
      runTelemetryWorker(port, {
        initSdk: async () => {
          called++;
          throw new Error("SDK não deveria ser importado");
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

// ---------------------------------------------------------------- ponte (main)

describe("telemetry-bridge (spawn/lifecycle no main)", () => {
  it("OTEL_ENABLED=0 → kill-switch: não sobe worker, resolve degradado", async () => {
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
      expect(logger.lines.join("\n")).toContain("telemetria desligada");
    } finally {
      setEnv("OTEL_ENABLED", prev);
    }
    // prova de que NÃO spawnou: o worker espião não chegou a receber init
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("workerPath inexistente → degrada com log, sem lançar", async () => {
    const logger = spyLogger();
    const bridge = createTelemetryBridge({
      workerPath: path.join(os.tmpdir(), "telemetry-worker-que-nao-existe.js"),
      logger,
    });
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.isUp()).toBe(false);
    expect(logger.lines.join("\n")).toContain("worker não encontrado");
    await bridge.stop(); // no-op seguro
  });

  it("emits do meter-ponte chegam no worker (thread real) e stop faz shutdown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-bridge-"));
    const logFile = path.join(dir, "worker.log");
    const logger = spyLogger();
    const bridge = createTelemetryBridge({ workerPath: writeSpyWorker(dir, logFile), logger });

    await bridge.init();
    expect(bridge.isUp()).toBe(true);
    expect(logger.lines.join("\n")).toContain("worker pronto — OTLP para http://spy:4318");

    // caminho real dos callers: core lazy resolve instrumento no primeiro emit
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

  it("init NÃO bloqueia o event loop do main (SDK pesado simulado no worker)", async () => {
    // o bug do W1: o import do SDK (~9s) travava o main. Aqui o worker queima
    // CPU 500ms DELE antes do ready; os timers do main têm que continuar
    // pontuais — se alguém voltar o init p/ o main thread, este teste falha.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-heavy-"));
    const file = path.join(dir, "heavy-worker.js");
    fs.writeFileSync(
      file,
      `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  if (m.type === "init") {
    const t0 = Date.now();
    while (Date.now() - t0 < 500) {} // simula o import do SDK travando SÓ o worker
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
    expect(fires.length).toBeGreaterThanOrEqual(18); // ~450ms de ticks durante o burn do worker
    let worst = 0;
    for (let i = 0; i < fires.length; i++) {
      worst = Math.max(worst, fires[i] - (t0 + (i + 1) * 25));
    }
    expect(worst).toBeLessThan(150); // init travando o main → drift ~500ms
    await bridge.stop();
  }, 20_000);
});

// ---------------------------------------------------------------- worker real

describe("telemetry-worker (REAL: SDK OTel de verdade dentro do worker)", () => {
  it("sobe, importa o SDK e reporta pronto; stop faz flush e encerra", async () => {
    const workerJs = await buildRealWorkerJs();
    const logger = spyLogger();
    const bridge = createTelemetryBridge({
      workerPath: workerJs,
      logger,
      readyTimeoutMs: 60_000, // import do sdk-node: ~9s no cold start medido no Windows
      stopTimeoutMs: 20_000,
    });
    const prev = process.env.OTEL_ENABLED;
    process.env.OTEL_ENABLED = "1";
    try {
      await bridge.init();
      expect(bridge.isUp()).toBe(true);
      expect(logger.lines.join("\n")).toContain("worker pronto — OTLP para");
      // um emit atravessa a ponte real (core do main → worker → SDK) sem lançar
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
