import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryCore, type Attributes, type MeterLike } from "../src/shared/telemetry-core";
import { scheduleTelemetryInit } from "../src/shared/telemetry-schedule";

/**
 * O bug histórico: counters/histograms declarados no module-load capturavam o
 * meter null (init é 3s pós-ready) e ficavam inertes para sempre. O core lazy
 * tem que: (1) não lançar antes do init, (2) gravar no primeiro emit pós-init,
 * (3) cachear por nome (declarações duplicadas = 1 instrumento).
 */
function fakeMeter(criados: Set<string>, added: { name: string; n: number; attrs?: Attributes }[], recorded: { name: string; n: number }[]): MeterLike {
  return {
    createCounter: (name) => {
      criados.add(name);
      return { add: (n, attrs) => added.push({ name, n, attrs }) };
    },
    createHistogram: (name) => {
      criados.add(name);
      return { record: (n) => recorded.push({ name, n }) };
    },
  };
}

describe("telemetry-core (instrumentos lazy)", () => {
  it("add/record antes do init não lançam e não gravam", () => {
    const core = createTelemetryCore();
    const c = core.counter("voicecast_sessions_total", "teste");
    const h = core.histogram("voicecast_finalize_seconds", "teste");
    expect(() => c.add(1, { mode: "screen" })).not.toThrow();
    expect(() => h.record(0.5)).not.toThrow();
  });

  it("pós-init: primeiro emit cria o instrumento e grava; cache por nome deduplica", () => {
    const core = createTelemetryCore();
    const criados = new Set<string>();
    const added: { name: string; n: number; attrs?: Attributes }[] = [];
    const recorded: { name: string; n: number }[] = [];
    core.setMeter(fakeMeter(criados, added, recorded));

    const c1 = core.counter("voicecast_sessions_total", "d1");
    const c2 = core.counter("voicecast_sessions_total", "d1"); // declaração duplicada (capture.ts/library.ts)
    const h = core.histogram("voicecast_session_start_seconds", "d2");

    c1.add(1, { mode: "screen" });
    c2.add(1, { mode: "window" });
    h.record(2.5, { mode: "screen", stage: "total" });
    h.record(3.5);

    expect(criados).toEqual(new Set(["voicecast_sessions_total", "voicecast_session_start_seconds"]));
    expect(added).toEqual([
      { name: "voicecast_sessions_total", n: 1, attrs: { mode: "screen" } },
      { name: "voicecast_sessions_total", n: 1, attrs: { mode: "window" } },
    ]);
    expect(recorded).toEqual([
      { name: "voicecast_session_start_seconds", n: 2.5 },
      { name: "voicecast_session_start_seconds", n: 3.5 },
    ]);
  });

  it("setMeter(null) após init volta a descartar emits sem lançar", () => {
    const core = createTelemetryCore();
    core.setMeter(fakeMeter(new Set(), [], []));
    const c = core.counter("m_total", "d");
    c.add(1);
    core.setMeter(null);
    expect(() => c.add(2)).not.toThrow();
  });
});

// W2b item 3: o agendamento saiu do index.ts (intestável) e o delay caiu de
// idle+15s p/ 2s — pós-W1 o SDK roda em worker_thread e o init não bloqueia
// mais o event loop; a guarda de idle (retry) continua.
describe("scheduleTelemetryInit (W2b)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delay inicial curto (2s, não 15s) e init dispara com captura idle", () => {
    vi.useFakeTimers();
    const init = vi.fn();
    scheduleTelemetryInit(() => "idle", init);
    vi.advanceTimersByTime(1_999);
    expect(init).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("captura não-idle adia o init (retry 5s) até voltar a idle", () => {
    vi.useFakeTimers();
    const init = vi.fn();
    let phase = "recording";
    scheduleTelemetryInit(() => phase, init);
    vi.advanceTimersByTime(2_000);
    expect(init).not.toHaveBeenCalled(); // não iniciou gravando
    vi.advanceTimersByTime(5_000);
    expect(init).not.toHaveBeenCalled(); // ainda gravando → retry
    phase = "idle";
    vi.advanceTimersByTime(5_000);
    expect(init).toHaveBeenCalledTimes(1);
  });
});
