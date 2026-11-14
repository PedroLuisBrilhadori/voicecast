/**
 * Pure editor segments logic (phase B) — no electron, testable.
 * Segment = a named piece of the session; clips and context are born from it.
 */

export interface SessionSegment {
  id: string;
  label: string;
  inS: number;
  outS: number;
}

/** Word with timing (subset of the transcript — start/end is enough to slice). */
export interface TimedWord {
  w: string;
  start: number;
  end: number;
}

let seq = 0;

export function newSegmentId(): string {
  return `seg-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validates/normalizes segments coming from the renderer or meta.json:
 * discards meaningless entries, clamps at 0, requires ≥0.2s, deduplicates
 * ids and sorts by inS. Always returns a new array, safe to persist.
 */
export function sanitizeSegments(raw: unknown): SessionSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionSegment[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, label, inS, outS } = item as Partial<SessionSegment>;
    const a = Number(inS);
    const b = Number(outS);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.max(0, a);
    const hi = Math.max(0, b);
    if (hi - lo < 0.2) continue;
    let key = typeof id === "string" && id ? id : "";
    if (!key || seen.has(key)) key = newSegmentId();
    seen.add(key);
    out.push({
      id: key,
      label:
        typeof label === "string" && label.trim()
          ? label.trim().slice(0, 80)
          : `Segment ${out.length + 1}`,
      inS: +lo.toFixed(2),
      outS: +hi.toFixed(2),
    });
  }
  return out.sort((x, y) => x.inS - y.inS);
}

const safeNamePart = (s: string) => s.replace(/[^\w.-]+/g, "-").slice(0, 60);

/** Base name of a segment's clip (same criteria as createClip). */
export function clipFileBase(label: string, inS: number, outS: number): string {
  return `${safeNamePart(label) || "segment"}-${Math.round(inS)}s-${Math.round(outS)}s`;
}

/** Base name of the combined cut (exportCut) — deterministic for re-export. */
export function cutFileBase(label: string, nSegments: number): string {
  return `${safeNamePart(label) || "cut"}-${nSegments}seg`;
}

/** Words touching the [inS, outS) interval — the segment's transcript slice. */
export function wordsInRange<T extends TimedWord>(words: T[], inS: number, outS: number): T[] {
  return words.filter((w) => w.end > inS && w.start < outS);
}
