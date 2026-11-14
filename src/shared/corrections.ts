/**
 * PURE voice-dictation correction engine (W2a — issues #3+#5) — no electron.
 *
 * The schema is the voice-dictation CORPUS (there is no written spec — the
 * disk rules): `datasets/transcriptions/YYYY-MM-DD/<HHMMSS-hash8>.json` with
 * words `{w, start, end, p}` and the correction in the `validation` block
 * written into the SAME JSON (parity with voice/corrections.py from the
 * :8700 panel):
 *
 *   "validation": {
 *     "corrected_text": "…final corrected text…",
 *     "ts": "2026-08-27T12:00:00",
 *     "n_edits": 1,
 *     "edits": [{"index": 3, "original_w": "notch", "corrected_w": "note"}],
 *     "labeled_by": "voicecast"
 *   }
 *
 * The original `text` field is NEVER changed in the corpus — the (raw,
 * corrected) pair is the training data. In voicecast (the session's
 * transcript.json) words ARE edited in place, preserving timings.
 */
import path from "node:path";

/** Transcript/corpus word with timing and confidence. */
export interface TimedWord {
  w: string;
  start: number;
  end: number;
  p: number;
}

/** Word-by-word edit coming from the UI (same shape as the old panel). */
export interface CorrectionEdit {
  /** position in the token stream (index into words). */
  index: number;
  originalW: string;
  correctedW: string;
}

/** Validation block written into the corpus JSON (same schema as voice). */
export interface ValidationBlock {
  corrected_text: string;
  ts: string;
  n_edits: number;
  edits: CorrectionEdit[];
  labeled_by: string;
}

/**
 * Validates/normalizes edits coming from the renderer — same policy as
 * voice/corrections.py: integer index ≥ 0, non-empty corrected_w (empty
 * corrections are discarded), original_w string (default ""). Returns a new
 * array.
 */
export function sanitizeEdits(raw: unknown): CorrectionEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: CorrectionEdit[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const { index, originalW, correctedW } = e as Partial<CorrectionEdit>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
    const fixed = typeof correctedW === "string" ? correctedW : "";
    if (!fixed) continue;
    out.push({
      index,
      originalW: typeof originalW === "string" ? originalW : "",
      correctedW: fixed,
    });
  }
  return out;
}

/** Text built from the words (same normalization as buildContext). */
export function wordsText(words: TimedWord[]): string {
  return words
    .map((w) => w.w)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Applies edits TO THE WORDS (without touching start/end/p) and recomposes
 * the text. Out-of-range edits are ignored. Returns new arrays/objects — the
 * original is never mutated.
 */
export function applyEditsToWords(
  words: TimedWord[],
  edits: CorrectionEdit[],
): { words: TimedWord[]; text: string } {
  const next = words.map((w) => ({ ...w }));
  for (const e of edits) {
    const w = next[e.index];
    if (!w) continue;
    w.w = e.correctedW;
  }
  return { words: next, text: wordsText(next) };
}

/** ts in the corpus format: local ISO with second precision (no Z). */
export function corpusTs(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** Validation block ready to write into the corpus (labeled_by identifies who labeled it). */
export function buildValidation(
  correctedText: string,
  edits: CorrectionEdit[],
  now: Date = new Date(),
  labeledBy = "voicecast",
): ValidationBlock {
  return {
    corrected_text: correctedText,
    ts: corpusTs(now),
    n_edits: edits.length,
    edits: edits.map((e) => ({ ...e })),
    labeled_by: labeledBy,
  };
}

/**
 * Corpus id safety guard (parity with history.find_item_path):
 * rejects separators/traversal — ids are `HHMMSS-hash8`.
 */
export function isValidItemId(id: string): boolean {
  return Boolean(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

/** Voice dataset root: env override, otherwise voice-dictation's %LOCALAPPDATA%. */
export function datasetRootFrom(
  env: NodeJS.ProcessEnv,
  join: (base: string, ...parts: string[]) => string = path.join,
): string | null {
  const override = env.VOICECAST_DATASET_DIR?.trim();
  if (override) return override;
  const local = env.LOCALAPPDATA?.trim();
  if (!local) return null;
  return join(local, "voice-dictation", "datasets");
}

// ── full rewrite (editor text mode) ────────────────────

/** number of word-by-word edits between the raw ASR and the corrected text
 *  (word-level Levenshtein — substitution costs 1, aligned to the edits[]
 *  model of corrections.py). */
export function diffWordCount(before: string, after: string): number {
  const a = before.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const b = after.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  // dictation texts are short (≤ hundreds of words) — O(n·m) is fine
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = a[i - 1] === b[j - 1]
        ? d[i - 1]![j - 1]!
        : 1 + Math.min(d[i - 1]![j - 1]!, d[i - 1]![j]!, d[i]![j - 1]!);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Redistributes the corrected text over the old timings (proportional to
 * per-word duration): the rewrite loses the ASR's 1:1 alignment, but each
 * new word gets a time slot coherent with the original speech.
 */
export function redistributeWords(oldWords: TimedWord[], corrected: string): TimedWord[] {
  const text = corrected.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const newWords = text.split(" ");
  if (!oldWords.length) {
    // no temporal reference: everything at t=0 (fake-hook/old dictations)
    return newWords.map((w) => ({ w, start: 0, end: 0, p: 1 }));
  }
  const t0 = oldWords[0]!.start;
  const t1 = Math.max(...oldWords.map((w) => w.end), oldWords[0]!.end);
  const span = Math.max(0.1, t1 - t0);
  const per = span / newWords.length;
  return newWords.map((w, i) => ({ w, start: +(t0 + i * per).toFixed(3), end: +(t0 + (i + 1) * per).toFixed(3), p: 1 }));
}
