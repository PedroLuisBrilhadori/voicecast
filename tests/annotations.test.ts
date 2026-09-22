/**
 * Testes do motor puro de anotações (src/shared/annotations.ts) — AN.2.
 * O contrato: replay do log é determinístico, undo/redo em qualquer ordem
 * reproduz o estado, e a borracha nos dois modos grava resultados invertíveis.
 */
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  emptyState,
  foldEvents,
  hitStrokes,
  simplifyPoints,
  splitStrokesByPath,
  type AnnotationEvent,
  type Pt,
  type StrokeSnapshot,
} from "../src/shared/annotations";

const pt = (x: number, y: number, ms = 0): Pt => ({ x, y, ms });

function strokeEvent(seq: number, id: string, points: Pt[]): AnnotationEvent {
  return { t: seq, seq, type: "stroke", id, color: "#ff4444", width: 4, points };
}

describe("fold do log", () => {
  it("adiciona strokes na ordem", () => {
    const s = foldEvents([
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      strokeEvent(2, "2", [pt(0, 10), pt(10, 10)]),
    ]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("laser e print não entram no estado geométrico", () => {
    const s = foldEvents([
      { t: 1, seq: 1, type: "laser", points: [pt(1, 1)] },
      { t: 2, seq: 2, type: "print", kind: "auto", file: "frames/print-2s.png", strokes: [] },
    ]);
    expect(s.strokes).toEqual([]);
  });
});

describe("undo/redo", () => {
  const base = (): AnnotationEvent[] => [
    strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
    strokeEvent(2, "2", [pt(0, 10), pt(10, 10)]),
  ];

  it("undo remove o último; redo devolve", () => {
    const s = foldEvents([...base(), { t: 3, seq: 3, type: "undo" }]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1"]);
    const s2 = foldEvents([...base(), { t: 3, seq: 3, type: "undo" }, { t: 4, seq: 4, type: "redo" }]);
    expect(s2.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("nova ação geométrica invalida o redo (semântica de editor)", () => {
    const s = foldEvents([
      ...base(),
      { t: 3, seq: 3, type: "undo" }, // sobra "1"
      strokeEvent(4, "4", [pt(50, 50), pt(60, 50)]), // redo morre aqui
      { t: 5, seq: 5, type: "redo" }, // no-op
    ]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "4"]);
  });

  it("undo de undo/redo de redo (alternância) é estável", () => {
    const events: AnnotationEvent[] = [...base()];
    for (let i = 3; i <= 10; i++) events.push({ t: i, seq: i, type: i % 2 ? "undo" : "redo" });
    const s = foldEvents(events);
    // terminou em redo (i=10) → estado final = ambos os strokes
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("undo em log vazio é no-op (não lança)", () => {
    const s = foldEvents([{ t: 1, seq: 1, type: "undo" }]);
    expect(s.strokes).toEqual([]);
  });

  it("undo de clear restaura tudo", () => {
    const s = foldEvents([
      ...base(),
      { t: 3, seq: 3, type: "clear", snapshots: [] }, // snapshots preenchidos pelo caller
      { t: 4, seq: 4, type: "undo" },
    ]);
    // clear com snapshots vazios não remove nada — o caller preenche; aqui
    // validamos o mecanismo com snapshots reais:
    const snapshots: StrokeSnapshot[] = [
      { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0)] },
      { id: "2", color: "#f00", width: 4, points: [pt(0, 10), pt(10, 10)] },
    ];
    const s2 = foldEvents([...base(), { t: 3, seq: 3, type: "clear", snapshots }, { t: 4, seq: 4, type: "undo" }]);
    expect(s2.strokes.map((st) => st.id)).toEqual(["1", "2"]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });
});

describe("borracha modo traço (hitStrokes)", () => {
  const strokes: StrokeSnapshot[] = [
    { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(100, 0)] },
    { id: "2", color: "#0f0", width: 4, points: [pt(0, 100), pt(100, 100)] },
  ];
  it("pega só o stroke tocado", () => {
    const hit = hitStrokes(strokes, [pt(50, 2)], 5);
    expect(hit.map((st) => st.id)).toEqual(["1"]);
  });
  it("nada tocado → vazio", () => {
    expect(hitStrokes(strokes, [pt(500, 500)], 5)).toEqual([]);
  });
});

describe("borracha modo normal (splitStrokesByPath)", () => {
  it("corta o meio do stroke em dois pedaços com ids derivados", () => {
    const strokes: StrokeSnapshot[] = [
      { id: "7", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(40, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(20, 0)], 4, (sid, i) => `${sid}.${i}`);
    expect(removed.map((st) => st.id)).toEqual(["7"]);
    expect(added.map((st) => st.id)).toEqual(["7.0", "7.1"]);
    expect(added[0]!.points).toEqual([pt(0, 0), pt(10, 0)]);
    expect(added[1]!.points).toEqual([pt(30, 0), pt(40, 0)]);
  });

  it("replay do evento erase-area restaura no undo com os MESMOS pedaços", () => {
    const events: AnnotationEvent[] = [
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(40, 0)]),
      {
        t: 2,
        seq: 2,
        type: "erase",
        mode: "area",
        removed: [{ id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(40, 0)] }],
        added: [
          { id: "2.0", color: "#ff4444", width: 4, points: [pt(0, 0), pt(10, 0)] },
          { id: "2.1", color: "#ff4444", width: 4, points: [pt(30, 0), pt(40, 0)] },
        ],
      },
      { t: 3, seq: 3, type: "undo" },
    ];
    const s = foldEvents(events);
    expect(s.strokes.map((st) => st.id)).toEqual(["1"]);
  });

  it("linha rápida (2 pontos distantes) cruzada pela borracha é removida", () => {
    // stroke esparso: (0,0)→(100,0), borracha passa no meio sem tocar endpoints
    const strokes: StrokeSnapshot[] = [
      { id: "7", color: "#f00", width: 4, points: [pt(0, 0), pt(100, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(48, 0), pt(52, 0)], 5, (sid, i) => `${sid}.${i}`);
    expect(removed.map((st) => st.id)).toEqual(["7"]);
    // pedaços de 1 ponto são descartados (não há o que desenhar)
    expect(added).toEqual([]);
  });

  it("stroke não tocado fica intacto", () => {
    const strokes: StrokeSnapshot[] = [
      { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(500, 500)], 4, (sid, i) => `${sid}.${i}`);
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe("decimação (simplifyPoints)", () => {
  it("descarta pontos colados, mantém primeiro e último", () => {
    const pts = [pt(0, 0), pt(1, 0, 5), pt(2, 0, 10), pt(50, 0, 60), pt(51, 0, 65), pt(100, 0, 120)];
    const out = simplifyPoints(pts, 3);
    expect(out.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(out[2]!.ms).toBe(120); // timestamps preservados dos mantidos
  });
  it("2 pontos ou menos passam direto", () => {
    expect(simplifyPoints([pt(0, 0), pt(1, 1)], 3).length).toBe(2);
  });
});

describe("determinismo do replay", () => {
  it("applyEvent sequencial == foldEvents do log completo", () => {
    const events: AnnotationEvent[] = [
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      { t: 2, seq: 2, type: "stroke", id: "2", color: "#00f", width: 8, points: [pt(0, 5), pt(10, 5)] },
      { t: 3, seq: 3, type: "undo" },
      { t: 4, seq: 4, type: "stroke", id: "4", color: "#0f0", width: 2, points: [pt(0, 20), pt(10, 20)] },
    ];
    const incremental = emptyState();
    for (const e of events) applyEvent(incremental, e);
    expect(incremental).toEqual(foldEvents(events));
  });
});
