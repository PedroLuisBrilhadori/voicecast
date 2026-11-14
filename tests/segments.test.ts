import { describe, expect, it } from "vitest";
import {
  clipFileBase,
  cutFileBase,
  sanitizeSegments,
  wordsInRange,
  type SessionSegment,
} from "../src/shared/segments";

/** Pure segments engine of the editor (phase B) — same guarantees the main
 *  process applies before persisting to meta.json. */
describe("sanitizeSegments", () => {
  it("keeps valid segments, rounds and sorts by inS", () => {
    const out = sanitizeSegments([
      { id: "b", label: "segundo", inS: 30.004, outS: 45 },
      { id: "a", label: "primeiro", inS: 5, outS: 12.5 },
    ]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0].inS).toBe(5);
    expect(out[1].inS).toBe(30);
  });

  it("discards garbage: non-array, non-object entries, NaN and duration < 0.2s", () => {
    expect(sanitizeSegments(undefined)).toEqual([]);
    expect(sanitizeSegments("x")).toEqual([]);
    expect(
      sanitizeSegments([
        null,
        42,
        "a",
        { id: "1", label: "nan", inS: Number.NaN, outS: 5 },
        { id: "2", label: "curto", inS: 10, outS: 10.1 },
      ]),
    ).toEqual([]);
  });

  it("clamps negative inS and keeps the clip when it still has duration", () => {
    const out = sanitizeSegments([{ id: "n", label: "neg", inS: -3, outS: 4 }]);
    expect(out).toEqual([{ id: "n", label: "neg", inS: 0, outS: 4 }]);
  });

  it("deduplicates repeated ids (second gets a new id, both persist)", () => {
    const out = sanitizeSegments([
      { id: "dup", label: "a", inS: 1, outS: 2 },
      { id: "dup", label: "b", inS: 5, outS: 6 },
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });

  it("empty label gets a numbered default and is trimmed to 80 chars", () => {
    const out = sanitizeSegments([
      { id: "1", label: "   ", inS: 1, outS: 2 },
      { id: "2", label: "x".repeat(120), inS: 3, outS: 4 },
    ]);
    expect(out[0].label).toBe("Segment 1");
    expect(out[1].label).toHaveLength(80);
  });
});

describe("derived file names", () => {
  it("clipFileBase sanitizes the label and embeds rounded times", () => {
    // semantics identical to the historical safeNamePart: each non-word run becomes
    // a hyphen (space and "!" are separate runs) — names match old clips
    expect(clipFileBase("Meu Trecho!", 12.4, 30.9)).toBe("Meu-Trecho--12s-31s");
    expect(clipFileBase("", 0, 5)).toBe("segment-0s-5s");
  });

  it("cutFileBase is deterministic so re-export overwrites", () => {
    expect(cutFileBase("corte", 3)).toBe("corte-3seg");
    expect(cutFileBase("", 1)).toBe("cut-1seg");
  });
});

describe("wordsInRange", () => {
  const words = [
    { w: "a", start: 0, end: 1 },
    { w: "b", start: 1, end: 2 },
    { w: "c", start: 2, end: 3 },
    { w: "d", start: 3, end: 4 },
  ];

  it("picks words that TOUCH the range (boundary: end == inS stays out)", () => {
    expect(wordsInRange(words, 1, 3).map((w) => w.w)).toEqual(["b", "c"]);
    expect(wordsInRange(words, 0, 1).map((w) => w.w)).toEqual(["a"]);
  });

  it("range in the middle of a word includes it (overlap, not containment)", () => {
    expect(wordsInRange(words, 1.5, 1.6).map((w) => w.w)).toEqual(["b"]);
  });
});

describe("renderer contract (serializable types)", () => {
  it("SessionSegment crosses JSON without loss", () => {
    const seg: SessionSegment = { id: "seg-1", label: "demo", inS: 1.5, outS: 9.25 };
    expect(JSON.parse(JSON.stringify(seg))).toEqual(seg);
  });
});
