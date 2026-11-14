import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryCore, type Attributes, type MeterLike } from "../src/shared/telemetry-core";
import { scheduleTelemetryInit } from "../src/shared/telemetry-schedule";

/**
 * The historical bug: counters/histograms declared at module-load captured the
 * null meter (init is 3s post-ready) and stayed inert forever. The lazy core
 * has to: (1) not throw before init, (2) record on the first post-init emit,
 * (3) cache by name (duplicate declarations = 1 instrument).
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

describe("telemetry-core (lazy instruments)", () => {
  it("add/record before init don't throw and don't record", () => {
    const core = createTelemetryCore();
    const c = core.counter("voicecast_sessions_total", "teste");
    const h = core.histogram("voicecast_finalize_seconds", "teste");
    expect(() => c.add(1, { mode: "screen" })).not.toThrow();
    expect(() => h.record(0.5)).not.toThrow();
  });

  it("post-init: first emit creates the instrument and records; cache by name dedupes", () => {
    const core = createTelemetryCore();
    const criados = new Set<string>();
    const added: { name: string; n: number; attrs?: Attributes }[] = [];
    const recorded: { name: string; n: number }[] = [];
    core.setMeter(fakeMeter(criados, added, recorded));

    const c1 = core.counter("voicecast_sessions_total", "d1");
    const c2 = core.counter("voicecast_sessions_total", "d1"); // duplicate declaration (capture.ts/library.ts)
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

  it("setMeter(null) after init goes back to dropping emits without throwing", () => {
    const core = createTelemetryCore();
    core.setMeter(fakeMeter(new Set(), [], []));
    const c = core.counter("m_total", "d");
    c.add(1);
    core.setMeter(null);
    expect(() => c.add(2)).not.toThrow();
  });
});

// W2b item 3: the scheduling moved out of index.ts (untestable) and the delay
// dropped from idle+15s to 2s — post-W1 the SDK runs in a worker_thread and init
// no longer blocks the event loop; the idle guard (retry) stays.
describe("scheduleTelemetryInit (W2b)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("short initial delay (2s, not 15s) and init fires with idle capture", () => {
    vi.useFakeTimers();
    const init = vi.fn();
    scheduleTelemetryInit(() => "idle", init);
    vi.advanceTimersByTime(1_999);
    expect(init).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("non-idle capture postpones init (5s retry) until back to idle", () => {
    vi.useFakeTimers();
    const init = vi.fn();
    let phase = "recording";
    scheduleTelemetryInit(() => phase, init);
    vi.advanceTimersByTime(2_000);
    expect(init).not.toHaveBeenCalled(); // didn't start while recording
    vi.advanceTimersByTime(5_000);
    expect(init).not.toHaveBeenCalled(); // still recording → retry
    phase = "idle";
    vi.advanceTimersByTime(5_000);
    expect(init).toHaveBeenCalledTimes(1);
  });
});
