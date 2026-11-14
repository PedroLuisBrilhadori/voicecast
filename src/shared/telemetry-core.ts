/**
 * LAZY metric instrument registry — pure (no electron/OTel SDK).
 *
 * The app's counters/histograms are declared at module-load, but SDK init is
 * late (initTelemetry runs 3s post-ready so it doesn't stall the F9 daemon
 * probe). Wrappers that captured the instrument at declaration time stayed
 * `null` forever (historical bug: no metric ever reached Grafana). Here the
 * instrument is resolved on the FIRST add/record and cached by name —
 * duplicate declarations of the same name (capture.ts/library.ts) land on
 * the same instrument. Emit before init is discarded (no feedback).
 */

export type Attributes = Record<string, string | number | boolean>;

/** Slice of the OTel Meter the core uses (structural — the real Meter fits). */
export interface MeterLike {
  createCounter(
    name: string,
    opts: { description: string },
  ): { add(n: number, attrs?: Attributes): void };
  createHistogram(
    name: string,
    opts: { description: string },
  ): { record(n: number, attrs?: Attributes): void };
}

export interface VCCounter {
  add: (n: number, attrs?: Attributes) => void;
}

export interface VCHistogram {
  record: (n: number, attrs?: Attributes) => void;
}

export interface TelemetryCore {
  counter(name: string, description: string): VCCounter;
  histogram(name: string, description: string): VCHistogram;
  /** Attaches the real meter post-init (or detaches with null). */
  setMeter(m: MeterLike | null): void;
}

export function createTelemetryCore(): TelemetryCore {
  let meter: MeterLike | null = null;
  const cache = new Map<string, unknown>();

  const instrument = <T>(name: string, create: (m: MeterLike) => T): T | undefined => {
    if (!meter) return undefined;
    let inst = cache.get(name) as T | undefined;
    if (!inst) {
      inst = create(meter);
      cache.set(name, inst);
    }
    return inst;
  };

  return {
    counter: (name, description) => ({
      add: (n, attrs) => {
        instrument(name, (m) => m.createCounter(name, { description }))?.add(n, attrs);
      },
    }),
    histogram: (name, description) => ({
      record: (n, attrs) => {
        instrument(name, (m) => m.createHistogram(name, { description }))?.record(n, attrs);
      },
    }),
    setMeter: (m) => {
      meter = m;
    },
  };
}
