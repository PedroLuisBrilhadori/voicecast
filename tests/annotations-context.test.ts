/**
 * Tests of the annotations summary for buildContext (AN.4) —
 * src/shared/annotations-context.ts. Contract: jsonl → "Anotações (N):"
 * section with relative time (fmtTs), type and matching burned print (path
 * only when the PNG exists in frames/); no marks → null (section disappears,
 * like the Segments one).
 */
import { describe, expect, it } from "vitest";
import {
  annotationSection,
  fmtTs,
  summarizeAnnotationEvents,
} from "../src/shared/annotations-context";
import type { AnnotationEvent, Pt } from "../src/shared/annotations";

const pt = (x: number, y: number, ms = 0): Pt => ({ x, y, ms });

/** Assembles the jsonl the way the engine writes it (1 JSON event per line). */
const jsonlOf = (...events: AnnotationEvent[]): string =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

// briefing fixture: ≥3 events (stroke, laser, clear) + burned print
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
  it("m:ss with leading zero", () => {
    expect(fmtTs(0)).toBe("0:00");
    expect(fmtTs(65.5)).toBe("1:06");
    expect(fmtTs(100.32)).toBe("1:40");
  });

  it("W2b: rounds the total before splitting — 59.7 becomes 1:00 (not 0:60)", () => {
    expect(fmtTs(59.7)).toBe("1:00");
    expect(fmtTs(59.4)).toBe("0:59");
    expect(fmtTs(119.5)).toBe("2:00");
  });
});

describe("summarizeAnnotationEvents (fixture)", () => {
  it("4 marks with relative time, type and counter", () => {
    const s = summarizeAnnotationEvents(FIXTURE, ["marker-1.png"])!;
    expect(s.marks.map((m) => m.kind)).toEqual(["brush", "laser", "clear", "print (marker)"]);
    expect(s.marks.map((m) => m.t)).toEqual([100.32, 132.4, 150.9, 152.2]);
    expect(s.activeStrokes).toBe(0); // clear took the stroke in the fold
    expect(s.skipped).toBe(0);
  });

  it("burned print matches the burned stroke (id in the print event)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, ["marker-1.png"])!;
    expect(s.marks[0]!.print).toBe("marker-1.png");
    expect(s.marks[3]!.print).toBe("marker-1.png"); // the print line itself
    expect(s.marks[1]!.print).toBeUndefined(); // laser is not burned
  });

  it("missing PNG in frames/ → line without path (tolerant)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, [])!;
    expect(s.marks.every((m) => m.print === undefined)).toBe(true);
  });

  it("stroke erased at the end of the log comes out marked (fold decides)", () => {
    const s = summarizeAnnotationEvents(FIXTURE, [])!;
    expect(s.marks[0]!.gone).toBe(true);
  });
});

describe("annotationSection (render)", () => {
  it("section lines with header, marks and print path", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/sessions/2026-09-27/1010-abcd1234/frames")!;
    expect(sec.count).toBe(4);
    expect(sec.lines).toEqual([
      "Annotations (4):",
      "1. 1:40 brush (erased)",
      "   Print: /data/sessions/2026-09-27/1010-abcd1234/frames/marker-1.png",
      "2. 2:12 laser",
      "3. 2:31 clear",
      "4. 2:32 print (marker)",
      "   Print: /data/sessions/2026-09-27/1010-abcd1234/frames/marker-1.png",
    ]);
  });

  it("framesDir with trailing slash doesn't duplicate the separator", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/frames/")!;
    expect(sec.lines[2]).toBe("   Print: /data/frames/marker-1.png");
  });

  it("no existing print → section without a Print line", () => {
    const sec = annotationSection(FIXTURE, [], "/data/frames")!;
    expect(sec.lines.some((l) => l.includes("Print:"))).toBe(false);
  });

  it("path with space comes out quoted (wslPathQuoted)", () => {
    const sec = annotationSection(FIXTURE, ["marker-1.png"], "/data/my frames")!;
    expect(sec.lines[2]).toBe('   Print: "/data/my frames/marker-1.png"');
  });
});

describe("undo/redo and eraser (reused fold)", () => {
  it("undo/redo count as marks and the final state reflects the fold", () => {
    const jsonl = jsonlOf(
      { t: 10, seq: 1, type: "stroke", id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(9, 9)] },
      { t: 11, seq: 2, type: "stroke", id: "2", color: "#ffd60a", width: 4, points: [pt(0, 10), pt(9, 19)] },
      { t: 12, seq: 3, type: "undo" },
      { t: 13, seq: 4, type: "redo" },
    );
    const sec = annotationSection(jsonl, [], "/f")!;
    expect(sec.count).toBe(4);
    expect(sec.activeStrokes).toBe(2);
    expect(sec.lines).toEqual(["Annotations (4):", "1. 0:10 brush", "2. 0:11 brush", "3. 0:12 undo", "4. 0:13 redo"]);
  });

  it("eraser in both modes has its own label and drops the stroke in the fold", () => {
    const stroke = { id: "1", color: "#ff4444", width: 4, points: [pt(0, 0), pt(9, 9)] };
    const jsonl = jsonlOf(
      { t: 10, seq: 1, type: "stroke", ...stroke },
      { t: 12, seq: 2, type: "erase", mode: "stroke", snapshots: [stroke] },
    );
    const sec = annotationSection(jsonl, [], "/f")!;
    expect(sec.lines).toEqual(["Annotations (2):", "1. 0:10 brush (erased)", "2. 0:12 eraser (stroke)"]);
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
    expect(area.lines[2]).toBe("2. 0:12 eraser (area)");
    expect(area.activeStrokes).toBe(1); // the piece that survived
  });
});

describe("missing/empty/corrupted jsonl", () => {
  it("empty string or whitespace only → null (section doesn't appear)", () => {
    expect(summarizeAnnotationEvents("", [])).toBeNull();
    expect(summarizeAnnotationEvents("  \n\n ", [])).toBeNull();
    expect(annotationSection("", [], "/f")).toBeNull();
  });

  it("corrupted lines are skipped (best-effort) and counted", () => {
    const s = summarizeAnnotationEvents(`{{{não sou json\n${JSON.stringify({ t: 5, seq: 1, type: "laser", points: [pt(1, 1)] })}\n`, [])!;
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0]!.kind).toBe("laser");
    expect(s.skipped).toBe(1);
  });
});
