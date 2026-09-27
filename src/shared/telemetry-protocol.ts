/**
 * Contrato de mensagens main ↔ worker de telemetria (W1).
 *
 * Desenho: o SDK OTel inteiro vive no worker (import pesado ~9s não toca o
 * event loop do main); o main mantém a API do core lazy e FORWARDA cada emit
 * como mensagem. Nomes/descrições dos instruments viajam nas mensagens — o
 * worker recria com o mesmo telemetry-core, então os nomes Prometheus não
 * mudam. Spans preservam hierarquia (id/parent) e timing (epoch-ms medido no
 * main, aplicado no span real pelo worker).
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
      /** id do span pai (com withSpan aninhado) — undefined = raiz */
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
