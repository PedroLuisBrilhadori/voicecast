/**
 * Tests of the pure annotations engine (src/shared/annotations.ts) — AN.2.
 * The contract: log replay is deterministic, undo/redo in any order
 * reproduces the state, and the eraser in both modes records invertible results.
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

describe("log fold", () => {
  it("adds strokes in order", () => {
    const s = foldEvents([
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      strokeEvent(2, "2", [pt(0, 10), pt(10, 10)]),
    ]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("laser and print don't enter the geometric state", () => {
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

  it("undo removes the last one; redo brings it back", () => {
    const s = foldEvents([...base(), { t: 3, seq: 3, type: "undo" }]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1"]);
    const s2 = foldEvents([...base(), { t: 3, seq: 3, type: "undo" }, { t: 4, seq: 4, type: "redo" }]);
    expect(s2.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("new geometric action invalidates redo (editor semantics)", () => {
    const s = foldEvents([
      ...base(),
      { t: 3, seq: 3, type: "undo" }, // leaves "1"
      strokeEvent(4, "4", [pt(50, 50), pt(60, 50)]), // redo dies here
      { t: 5, seq: 5, type: "redo" }, // no-op
    ]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "4"]);
  });

  it("undo of undo/redo of redo (alternating) is stable", () => {
    const events: AnnotationEvent[] = [...base()];
    for (let i = 3; i <= 10; i++) events.push({ t: i, seq: i, type: i % 2 ? "undo" : "redo" });
    const s = foldEvents(events);
    // ended in redo (i=10) → final state = both strokes
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });

  it("undo on empty log is a no-op (doesn't throw)", () => {
    const s = foldEvents([{ t: 1, seq: 1, type: "undo" }]);
    expect(s.strokes).toEqual([]);
  });

  it("undo of clear restores everything", () => {
    const s = foldEvents([
      ...base(),
      { t: 3, seq: 3, type: "clear", snapshots: [] }, // snapshots filled by the caller
      { t: 4, seq: 4, type: "undo" },
    ]);
    // clear with empty snapshots removes nothing — the caller fills them; here
    // we validate the mechanism with real snapshots:
    const snapshots: StrokeSnapshot[] = [
      { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0)] },
      { id: "2", color: "#f00", width: 4, points: [pt(0, 10), pt(10, 10)] },
    ];
    const s2 = foldEvents([...base(), { t: 3, seq: 3, type: "clear", snapshots }, { t: 4, seq: 4, type: "undo" }]);
    expect(s2.strokes.map((st) => st.id)).toEqual(["1", "2"]);
    expect(s.strokes.map((st) => st.id)).toEqual(["1", "2"]);
  });
});

describe("eraser stroke mode (hitStrokes)", () => {
  const strokes: StrokeSnapshot[] = [
    { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(100, 0)] },
    { id: "2", color: "#0f0", width: 4, points: [pt(0, 100), pt(100, 100)] },
  ];
  it("picks only the touched stroke", () => {
    const hit = hitStrokes(strokes, [pt(50, 2)], 5);
    expect(hit.map((st) => st.id)).toEqual(["1"]);
  });
  it("nothing touched → empty", () => {
    expect(hitStrokes(strokes, [pt(500, 500)], 5)).toEqual([]);
  });
});

describe("eraser normal mode (splitStrokesByPath)", () => {
  it("cuts the middle of the stroke into two pieces with derived ids", () => {
    const strokes: StrokeSnapshot[] = [
      { id: "7", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(40, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(20, 0)], 4, (sid, i) => `${sid}.${i}`);
    expect(removed.map((st) => st.id)).toEqual(["7"]);
    expect(added.map((st) => st.id)).toEqual(["7.0", "7.1"]);
    expect(added[0]!.points).toEqual([pt(0, 0), pt(10, 0)]);
    expect(added[1]!.points).toEqual([pt(30, 0), pt(40, 0)]);
  });

  it("erase-area event replay restores on undo with the SAME pieces", () => {
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

  it("fast line (2 distant points) crossed by the eraser is removed", () => {
    // sparse stroke: (0,0)→(100,0), eraser passes in the middle without touching endpoints
    const strokes: StrokeSnapshot[] = [
      { id: "7", color: "#f00", width: 4, points: [pt(0, 0), pt(100, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(48, 0), pt(52, 0)], 5, (sid, i) => `${sid}.${i}`);
    expect(removed.map((st) => st.id)).toEqual(["7"]);
    // 1-point pieces are discarded (nothing to draw)
    expect(added).toEqual([]);
  });

  it("untouched stroke stays intact", () => {
    const strokes: StrokeSnapshot[] = [
      { id: "1", color: "#f00", width: 4, points: [pt(0, 0), pt(10, 0)] },
    ];
    const { removed, added } = splitStrokesByPath(strokes, [pt(500, 500)], 4, (sid, i) => `${sid}.${i}`);
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe("decimation (simplifyPoints)", () => {
  it("discards glued points, keeps first and last", () => {
    const pts = [pt(0, 0), pt(1, 0, 5), pt(2, 0, 10), pt(50, 0, 60), pt(51, 0, 65), pt(100, 0, 120)];
    const out = simplifyPoints(pts, 3);
    expect(out.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(out[2]!.ms).toBe(120); // timestamps preserved from the kept points
  });
  it("2 points or fewer pass through as-is", () => {
    expect(simplifyPoints([pt(0, 0), pt(1, 1)], 3).length).toBe(2);
  });
});

describe("replay determinism", () => {
  it("sequential applyEvent == foldEvents of the full log", () => {
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

describe("clear (AN: main↔overlay desync)", () => {
  it("clear with correct snapshots clears everything", () => {
    const strokes = [
      { id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(10, 0)] },
      { id: "2", color: "#ffd60a", width: 4, points: [pt(0, 10), pt(10, 10)] },
    ];
    const s = foldEvents([
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      strokeEvent(2, "2", [pt(0, 10), pt(10, 10)]),
      { t: 3, seq: 3, type: "clear", snapshots: strokes },
    ]);
    expect(s.strokes).toEqual([]);
  });

  it("clear with EMPTY snapshots doesn't clear (desync signature: main cleared first and returned snapshots=[])", () => {
    const s = foldEvents([
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      { t: 2, seq: 2, type: "clear", snapshots: [] },
    ]);
    expect(s.strokes).toHaveLength(1);
  });

  it("undo after clear restores the strokes (snapshots are the history)", () => {
    const strokes = [{ id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(10, 0)] }];
    const s = foldEvents([
      strokeEvent(1, "1", [pt(0, 0), pt(10, 0)]),
      { t: 2, seq: 2, type: "clear", snapshots: strokes },
      { t: 3, seq: 3, type: "undo" },
    ]);
    expect(s.strokes).toHaveLength(1);
  });
});
