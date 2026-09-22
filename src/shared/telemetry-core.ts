/**
 * Registro LAZY de instrumentos de métrica — puro (sem electron/SDK OTel).
 *
 * Os counters/histogramas do app são declarados no module-load, mas o init do
 * SDK é tardio (initTelemetry roda 3s pós-ready p/ não travar o probe do
 * daemon F9). Wrappers que capturavam o instrumento na declaração ficavam
 * `null` para sempre (bug histórico: nenhuma métrica chegava ao Grafana).
 * Aqui o instrumento é resolvido no PRIMEIRO add/record e cacheado por nome —
 * declarações duplicadas do mesmo nome (capture.ts/library.ts) caem no mesmo
 * instrumento. Emit antes do init é descartado (sem retroalimentação).
 */

export type Attributes = Record<string, string | number | boolean>;

/** Fatia do Meter OTel usada pelo core (estrutural — o Meter real encaixa). */
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
  /** Liga o meter real pós-init (ou desliga com null). */
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
