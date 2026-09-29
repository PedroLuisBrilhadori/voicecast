/**
 * Testes do resumo de anotações para o buildContext (AN.4) —
 * src/shared/annotations-context.ts. Contrato: jsonl → seção "Anotações (N):"
 * com tempo relativo (fmtTs), tipo e print queimado correspondente (path só
 * quando o PNG existe em frames/); sem marcações → null (seção some, como a
 * de Trechos).
 */
import { describe, expect, it } from "vitest";
import {
  annotationSection,
  fmtTs,
  summarizeAnnotationEvents,
} from "../src/shared/annotations-context";
import type { AnnotationEvent, Pt } from "../src/shared/annotations";

const pt = (x: number, y: number, ms = 0): Pt => ({ x, y, ms });

/** Monta o jsonl como o engine grava (1 evento JSON por linha). */
const jsonlOf = (...events: AnnotationEvent[]): string =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

// fixture do briefing: ≥3 eventos (stroke, laser, clear) + print queimado
const FIXTURE = jsonlOf(
  { t: 100.32, seq: 1, type: "stroke", id: "1", color: "#ff4444", width: 4, points: [pt(10, 10), pt(200, 120, 400)] },
  { t: 132.4, seq: 2, type: "laser", points: [pt(300, 300), pt(400, 310, 300)] },
  {
    t: 150.9,
    seq: 3,
    type: "clear",
    snapshots: [{ id: "1", color: "#ff4444", width: 4, points: [pt(10, 10), pt(200, 120, 400)] }],
  },
  { t: 152.2, seq: 4, type: "print", kind: "marker", file: "frames/marker-1.png", strokes: ["1"] },
);

describe("fmtTs", () => {
  it("m:ss com zero à esquerda", () => {
    expect(fmtTs(0)).toBe("0:00");
    expect(fmtTs(65.5)).toBe("1:06");
    expect(fmtTs(100.32)).toBe("1:40");
  });

  it("W2b: arredonda o total antes de quebrar — 59.7 vira 1:00 (não 0:60)", () => {
    expect(fmtTs(59.7)).toBe("1:00");
    expect(fmtTs(59.4)).toBe("0:59");
    expect(fmtTs(119.5)).toBe("2:00");
  });
});

describe("summarizeAnnotationEvents (fixture)", () => {
  it("4 marcações com tempo relativo, tipo e contador", () => {
    const s = summarizeAnnotationEvents(FIXTURE, ["marker-1.png"])!;
    expect(s.marks.map((m) => m.kind)).toEqual(["pincel", "laser", "limpar", "print (marker)"]);
    expect(s.marks.map((m) => m.t)).toEqual([100.32, 132.4, 150.9, 152.2]);
    expect(s.activeStrokes).toBe(0); // clear levou o stroke no fold
    expect(s.skipped).toBe(0);
  });

  it("print queimado corresponde ao stroke queimado (id no evento print)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, ["marker-1.png"])!;
    expect(s.marks[0]!.print).toBe("marker-1.png");
    expect(s.marks[3]!.print).toBe("marker-1.png"); // a própria linha do print
    expect(s.marks[1]!.print).toBeUndefined(); // laser não é queimado
  });

  it("PNG inexistente em frames/ → linha sem path (tolerante)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, [])!;
    expect(s.marks.every((m) => m.print === undefined)).toBe(true);
  });

  it("stroke apagado no fim do log sai marcado (fold decide)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, [])!;
    expect(s.marks[0]!.gone).toBe(true);
  });
});

describe("annotationSection (render)", () => {
  it("linhas da seção com header, marcações e path do print", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/sessions/2026-09-27/1010-abcd1234/frames")!;
    expect(sec.count).toBe(4);
    expect(sec.lines).toEqual([
      "Anotações (4):",
      "1. 1:40 pincel (apagado)",
      "   Print: /data/sessions/2026-09-27/1010-abcd1234/frames/marker-1.png",
      "2. 2:12 laser",
      "3. 2:31 limpar",
      "4. 2:32 print (marker)",
      "   Print: /data/sessions/2026-09-27/1010-abcd1234/frames/marker-1.png",
    ]);
  });

  it("framesDir com barra vira não duplica o separador", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/frames/")!;
    expect(sec.lines[2]).toBe("   Print: /data/frames/marker-1.png");
  });

  it("sem print existente → seção sem linha de Print", () => {
    const sec = annotationSection(FIXTURE, [], "/data/frames")!;
    expect(sec.lines.some((l) => l.includes("Print:"))).toBe(false);
  });

  it("path com espaço sai quotado (wslPathQuoted)", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/my frames")!;
    expect(sec.lines[2]).toBe('   Print: "/data/my frames/marker-1.png"');
  });
});

describe("undo/redo e borracha (fold reaproveitado)", () => {
  it("undo/redo contam como marcação e o estado final reflete o fold", () => {
    const jsonl = jsonlOf(
      { t: 10, seq: 1, type: "stroke", id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(9, 9)] },
      { t: 11, seq: 2, type: "stroke", id: "2", color: "#ffd60a", width: 4, points: [pt(0, 10), pt(9, 19)] },
      { t: 12, seq: 3, type: "undo" },
      { t: 13, seq: 4, type: "redo" },
    );
    const sec = annotationSection(jsonl, [], "/f")!;
    expect(sec.count).toBe(4);
    expect(sec.activeStrokes).toBe(2);
    expect(sec.lines).toEqual(["Anotações (4):", "1. 0:10 pincel", "2. 0:11 pincel", "3. 0:12 desfazer", "4. 0:13 refazer"]);
  });

  it("borracha nos dois modos tem rótulo próprio e derruba o stroke no fold", () => {
    const stroke = { id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(9, 9)] };
    const jsonl = jsonlOf(
      { t: 10, seq: 1, type: "stroke", ...stroke },
      { t: 12, seq: 2, type: "erase", mode: "stroke", snapshots: [stroke] },
    );
    const sec = annotationSection(jsonl, [], "/f")!;
    expect(sec.lines).toEqual(["Anotações (2):", "1. 0:10 pincel (apagado)", "2. 0:12 borracha (traço)"]);
    expect(sec.activeStrokes).toBe(0);

    const area = annotationSection(
      jsonlOf(
        { t: 10, seq: 1, type: "stroke", ...stroke },
        {
          t: 12,
          seq: 2,
          type: "erase",
          mode: "area",
          removed: [stroke],
          added: [{ id: "2.0", color: "#ff4444", width: 4, points: [pt(0, 0), pt(4, 4)] }],
        },
      ),
      [],
      "/f",
    )!;
    expect(area.lines[2]).toBe("2. 0:12 borracha (área)");
    expect(area.activeStrokes).toBe(1); // pedaço que sobrou
  });
});

describe("jsonl ausente/vazio/corrompido", () => {
  it("string vazia ou só whitespace → null (seção não aparece)", () => {
    expect(summarizeAnnotationEvents("", [])).toBeNull();
    expect(summarizeAnnotationEvents("  \n\n ", [])).toBeNull();
    expect(annotationSection("", [], "/f")).toBeNull();
  });

  it("linhas corrompidas são puladas (best-effort) e contadas", () => {
    const s = summarizeAnnotationEvents(`{{{não sou json\n${JSON.stringify({ t: 5, seq: 1, type: "laser", points: [pt(1, 1)] })}\n`, [])!;
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0]!.kind).toBe("laser");
    expect(s.skipped).toBe(1);
  });
});
