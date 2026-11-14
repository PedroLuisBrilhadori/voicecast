/**
 * Summary of a session's annotations for buildContext (AN.4 of
 * PLANO-ANOTACOES-TELA) — PURE, no electron: receives the contents of
 * `annotations.jsonl` and the existing PNGs in `frames/` and returns the lines
 * of the "Annotations (N):" section. `library.ts` only consumes it.
 *
 * Contract:
 *  - jsonl times are relative to the session's real `startedAt` → formatted
 *    with fmtTs (m:ss), like the other context sections.
 *  - "Corresponding" burned-in screenshot: the `print` event carries the file
 *    (`frames/<name>.png`) and the ids of the burned strokes; the path only
 *    makes it into the line if the PNG exists in `frames/` (caller's readdir —
 *    tolerant to misses, the line comes out without a path).
 *  - The pure engine's fold (`foldEvents`) decides what survived: a stroke
 *    not in the final state comes out marked "(erased)" (erased/cleared/undone).
 *  - Empty jsonl/no events → null (the section doesn't appear — same behavior
 *    as the Segments section).
 */
import { foldEvents, type AnnotationEvent } from "./annotations";
import { wslPathQuoted } from "./paths";

/** Relative m:ss time — same format as the other buildContext sections.
 * Rounds the TOTAL before splitting (W2b): 59.7 becomes "1:00", not "0:60". */
export function fmtTs(s: number): string {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** A mark cited in the section. */
export interface AnnotationMark {
  /** t relative to the session (s), as recorded in the jsonl. */
  t: number;
  /** Display label of the type (laser, brush, eraser…, print (marker)…). */
  kind: string;
  /** Corresponding burned-in PNG (basename present in frames/), if any. */
  print?: string;
  /** Stroke that didn't survive the log's final state (erased/undone). */
  gone?: boolean;
}

export interface AnnotationSummary {
  marks: AnnotationMark[];
  /** Active strokes in the final state (fold of the full log). */
  activeStrokes: number;
  /** Corrupted/unreadable lines skipped (context is best-effort). */
  skipped: number;
}

/** Section ready for buildContext. */
export interface AnnotationSection extends AnnotationSummary {
  /** number of cited marks (= marks included in the context). */
  count: number;
  /** Markdown lines (header + one per mark). */
  lines: string[];
}

/** Display label per event type (AN plan vocabulary). */
function kindLabel(e: AnnotationEvent): string {
  switch (e.type) {
    case "stroke":
      return "brush";
    case "laser":
      return "laser";
    case "erase":
      return e.mode === "stroke" ? "eraser (stroke)" : "eraser (area)";
    case "clear":
      return "clear";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "print":
      return `print (${e.kind})`;
  }
}

const basename = (f: string): string => f.split(/[\\/]/).pop() ?? f;

/** Jsonl → events (empty/corrupted lines skipped, counted in skipped). */
function parseEvents(jsonl: string): { events: AnnotationEvent[]; skipped: number } {
  const events: AnnotationEvent[] = [];
  let skipped = 0;
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as AnnotationEvent);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/**
 * Aggregates the session's jsonl into citable marks. Returns null when there
 * are no events at all (the section disappears from the context).
 */
export function summarizeAnnotationEvents(
  jsonl: string,
  frameFiles: readonly string[],
): AnnotationSummary | null {
  const { events, skipped } = parseEvents(jsonl);
  if (!events.length) return null;

  const existing = new Set(frameFiles);
  // stroke id → burned-in screenshot that includes it (first in log order
  // whose PNG exists — marker/auto burn the strokes active at that instant)
  const printByStroke = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "print") continue;
    const base = basename(e.file);
    if (!existing.has(base)) continue;
    for (const id of e.strokes) if (!printByStroke.has(id)) printByStroke.set(id, base);
  }

  const activeIds = new Set(foldEvents(events).strokes.map((s) => s.id));
  const marks: AnnotationMark[] = events.map((e) => {
    const mark: AnnotationMark = { t: e.t, kind: kindLabel(e) };
    if (e.type === "print") {
      const base = basename(e.file);
      if (existing.has(base)) mark.print = base;
    } else if (e.type === "stroke") {
      if (!activeIds.has(e.id)) mark.gone = true;
      const p = printByStroke.get(e.id);
      if (p) mark.print = p;
    }
    return mark;
  });

  return { marks, activeStrokes: activeIds.size, skipped };
}

/**
 * Full section: lines ready for buildContext's `lines.push(...)`.
 * Null when there are no marks (the caller emits nothing — neither the
 * section nor the counter).
 */
export function annotationSection(
  jsonl: string,
  frameFiles: readonly string[],
  framesDir: string,
): AnnotationSection | null {
  const s = summarizeAnnotationEvents(jsonl, frameFiles);
  if (!s || !s.marks.length) return null;
  const dir = framesDir.replace(/[\\/]+$/, "");
  const lines: string[] = [`Annotations (${s.marks.length}):`];
  s.marks.forEach((m, i) => {
    lines.push(`${i + 1}. ${fmtTs(m.t)} ${m.kind}${m.gone ? " (erased)" : ""}`);
    if (m.print) lines.push(`   Print: ${wslPathQuoted(`${dir}/${m.print}`)}`);
  });
  return { ...s, count: s.marks.length, lines };
}
