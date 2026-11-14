/**
 * Pure dictation correction engine (W2a) — the schema is the voice corpus
 * (words {w,start,end,p} + validation block, parity with corrections.py).
 */
import { describe, expect, it } from "vitest";
import {
  applyEditsToWords,
  buildValidation,
  corpusTs,
  datasetRootFrom,
  diffWordCount,
  isValidItemId,
  redistributeWords,
  sanitizeEdits,
  wordsText,
  type TimedWord,
} from "../src/shared/corrections";

const WORDS: TimedWord[] = [
  { w: "vamos", start: 0.0, end: 0.42, p: 0.71 },
  { w: "favar", start: 0.5, end: 0.9, p: 0.44 }, // ASR got it wrong
  { w: "isso", start: 1.0, end: 1.3, p: 0.95 },
  { w: "hoje", start: 1.4, end: 1.8, p: 0.9 },
];

describe("sanitizeEdits (parity with corrections.py)", () => {
  it("accepts valid edits and normalizes fields", () => {
    const edits = sanitizeEdits([
      { index: 1, originalW: "favar", correctedW: "fechar" },
      { index: 2, originalW: "", correctedW: "isso" },
    ]);
    expect(edits).toEqual([
      { index: 1, originalW: "favar", correctedW: "fechar" },
      { index: 2, originalW: "", correctedW: "isso" },
    ]);
  });

  it("discards non-integer/negative index and empty correction (same rule as the panel)", () => {
    expect(
      sanitizeEdits([
        { index: 1.5, correctedW: "x" }, // non-integer
        { index: -1, correctedW: "x" }, // negative
        { index: 0, correctedW: "" }, // empty correction
        { index: 0 }, // no correctedW
        "lixo",
        null,
      ]),
    ).toEqual([]);
  });

  it("non-array input → []", () => {
    expect(sanitizeEdits(undefined)).toEqual([]);
    expect(sanitizeEdits({})).toEqual([]);
  });
});

describe("applyEditsToWords — preserves timings", () => {
  it("swaps only the word text; start/end/p untouched", () => {
    const r = applyEditsToWords(WORDS, [{ index: 1, originalW: "favar", correctedW: "fechar" }]);
    expect(r.words[1]).toEqual({ w: "fechar", start: 0.5, end: 0.9, p: 0.44 });
    // rest intact
    expect(r.words[0]).toEqual(WORDS[0]);
    expect(r.words[3]).toEqual(WORDS[3]);
  });

  it("reassembles the text from the words", () => {
    const r = applyEditsToWords(WORDS, [{ index: 1, originalW: "favar", correctedW: "fechar" }]);
    expect(r.text).toBe("vamos fechar isso hoje");
  });

  it("edit out of range is ignored (without throwing)", () => {
    const r = applyEditsToWords(WORDS, [{ index: 99, originalW: "x", correctedW: "y" }]);
    expect(r.words.map((w) => w.w)).toEqual(["vamos", "favar", "isso", "hoje"]);
  });

  it("doesn't mutate the original array", () => {
    const antes = JSON.parse(JSON.stringify(WORDS));
    applyEditsToWords(WORDS, [{ index: 0, originalW: "vamos", correctedW: "vámos" }]);
    expect(WORDS).toEqual(antes);
  });

  it("wordsText normalizes spaces", () => {
    expect(wordsText([{ w: "a", start: 0, end: 1, p: 1 }, { w: " b ", start: 1, end: 2, p: 1 }])).toBe("a b");
  });
});

describe("validation block — corpus schema", () => {
  it("same shape as corrections.py (corrected_text/ts/n_edits/edits/labeled_by)", () => {
    const now = new Date(2026, 8, 29, 12, 34, 56);
    const edits = [{ index: 1, originalW: "favar", correctedW: "fechar" }];
    const v = buildValidation("vamos fechar isso hoje", edits, now);
    expect(Object.keys(v).sort()).toEqual([
      "corrected_text",
      "edits",
      "labeled_by",
      "n_edits",
      "ts",
    ]);
    expect(v.corrected_text).toBe("vamos fechar isso hoje");
    expect(v.n_edits).toBe(1);
    expect(v.edits).toEqual(edits);
    expect(v.labeled_by).toBe("voicecast");
    expect(v.ts).toBe("2026-09-29T12:34:56"); // corpus format: local ISO without Z
  });
});

describe("corpus guards", () => {
  it("valid id HHMMSS-hash8; traversal rejected", () => {
    expect(isValidItemId("011430-6f1d3072")).toBe(true);
    expect(isValidItemId("")).toBe(false);
    expect(isValidItemId("../../etc/passwd")).toBe(false);
    expect(isValidItemId("a/b")).toBe(false);
    expect(isValidItemId("a\\b")).toBe(false);
  });

  it("dataset root: env override else %LOCALAPPDATA%\\voice-dictation\\datasets", () => {
    expect(datasetRootFrom({ VOICECAST_DATASET_DIR: "/tmp/ds" })).toBe("/tmp/ds");
    expect(
      datasetRootFrom({ LOCALAPPDATA: "C:\\Users\\pedro\\AppData\\Local" }, (base, ...p) =>
        [base, ...p].join("\\"),
      ),
    ).toBe("C:\\Users\\pedro\\AppData\\Local\\voice-dictation\\datasets");
    expect(datasetRootFrom({})).toBeNull(); // fail-soft: no base, no dataset
  });

  it("corpusTs zero-pads month/day/hour", () => {
    expect(corpusTs(new Date(2026, 0, 5, 3, 7, 9))).toBe("2026-01-05T03:07:09");
  });
});

// ── full rewrite (text mode — maintainer request 2026-09-29) ──
describe("full rewrite", () => {
  it("diffWordCount counts insertions, deletions and substitutions", () => {
    expect(diffWordCount("o gato subiu no telhado", "o gato pulou no telhado")).toBe(1);
    // subiu→pulou (1 subst) + bem alto no telhado (4 insertions)
    expect(diffWordCount("o gato subiu", "o gato pulou bem alto no telhado")).toBe(5);
    expect(diffWordCount("mesmo texto", "mesmo texto")).toBe(0);
    expect(diffWordCount("", "uma frase nova")).toBe(3);
  });

  it("redistributeWords distributes the new text over the original span", () => {
    const old = [
      { w: "a", start: 10, end: 11, p: 0.9 },
      { w: "b", start: 11, end: 12, p: 0.8 },
    ];
    const out = redistributeWords(old, "x y z");
    expect(out.map((w) => w.w)).toEqual(["x", "y", "z"]);
    expect(out[0]!.start).toBe(10);
    expect(out[out.length - 1]!.end).toBe(12); // span preserved
    // contiguous slots
    expect(out[1]!.start).toBeCloseTo(out[0]!.end, 3);
  });

  it("redistributeWords without temporal reference zeroes timings; empty text → []", () => {
    expect(redistributeWords([], "a b").every((w) => w.start === 0 && w.end === 0)).toBe(true);
    expect(redistributeWords([{ w: "a", start: 1, end: 2, p: 0.9 }], "  ")).toEqual([]);
  });
});
