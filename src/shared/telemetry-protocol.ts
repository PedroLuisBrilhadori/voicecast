/**
 * Message contract main ↔ telemetry worker (W1).
 *
 * Design: the entire OTel SDK lives in the worker (the heavy ~9s import never
 * touches the main event loop); main keeps the core API lazy and FORWARDS each
 * emit as a message. Instrument names/descriptions travel inside the messages —
 * the worker recreates them with the same telemetry-core, so the Prometheus
 * names don't change. Spans preserve hierarchy (id/parent) and timing
 * (epoch-ms measured in main, applied to the real span by the worker).
 */
import type { Attributes } from "./telemetry-core";

/** main → worker */
export type TelemetryWorkerInbound =
  | { type: "init" }
  | { type: "counter"; name: string; description: string; n: number; attrs?: Attributes }
  | { type: "histogram"; name: string; description: string; n: number; attrs?: Attributes }
  | {
      type: "span-start";
      id: number;
      /** parent span id (nested withSpan) — undefined = root */
      parent?: number;
      name: string;
      attrs: Attributes;
      startMs: number;
    }
  | { type: "span-end"; id: number; endMs: number; error?: string }
  | { type: "shutdown" };

/** worker → main */
export type TelemetryWorkerOutbound =
  | { type: "ready"; endpoint: string }
  | { type: "disabled" }
  | { type: "error"; message: string }
  | { type: "shutdown-done" };
