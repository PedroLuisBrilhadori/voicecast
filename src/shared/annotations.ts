/**
 * PURE on-screen annotation engine (PLANO-ANOTACOES-TELA, AN.2) — no
 * electron, used by main (log writing/replay), by the renderer (redraw from
 * the same fold) and by tests.
 *
 * Principles:
 *  - The LOG is the source of truth (`annotations.jsonl`); state is its fold.
 *  - Each geometric event carries enough to INVERT itself (undo) —
 *    including the area eraser, which records the split result
 *    (removed/added) instead of recomputing geometry on replay.
 *  - Undo/redo are log events too: replay is deterministic.
 *  - A new geometric action clears the redo (editor semantics); the log
 *    keeps everything — replay reproduces exactly what the user did.
 *  - Coordinates in PHYSICAL px (DPI 1.53 — lesson F0); `ms` relative to the
 *    stroke start (capture timestamps), `t` relative to the session.
 */

export type AnnotationTool = "laser" | "brush" | "eraser";
export type EraserMode = "stroke" | "area";

/** Point of a stroke/laser: physical px + ms relative to the first point. */
export interface Pt {
  x: number;
  y: number;
  ms: number;
}

/** An active stroke (or the piece left over from a split). id: "18" | "18.0"… */
export interface StrokeSnapshot {
  id: string;
  color: string;
  width: number;
  points: Pt[];
}

export type AnnotationEvent =
  | { t: number; seq: number; type: "stroke"; id: string; color: string; width: number; points: Pt[] }
  /** Laser: path persisted in the log (attention), ephemeral visual in the renderer. */
  | { t: number; seq: number; type: "laser"; points: Pt[] }
  /** Stroke-mode eraser: removes whole strokes (restorable). */
  | { t: number; seq: number; type: "erase"; mode: "stroke"; snapshots: StrokeSnapshot[] }
  /** Normal-mode eraser: split result recorded (removed went away, added stayed). */
  | { t: number; seq: number; type: "erase"; mode: "area"; removed: StrokeSnapshot[]; added: StrokeSnapshot[] }
  | { t: number; seq: number; type: "clear"; snapshots: StrokeSnapshot[] }
  | { t: number; seq: number; type: "undo" }
  | { t: number; seq: number; type: "redo" }
  /** System-generated burned-in screenshot (marker/auto-print/manual). */
  | { t: number; seq: number; type: "print"; kind: "marker" | "auto" | "manual"; file: string; strokes: string[] };

// ── log fold → state ──────────────────────────────────────────────────

/** Applied (invertible) operation — derived from the geometric events. */
type Op =
  | { kind: "add"; strokes: StrokeSnapshot[] }
  | { kind: "remove"; snapshots: StrokeSnapshot[] }
  | { kind: "replace"; removed: StrokeSnapshot[]; added: StrokeSnapshot[] };

export interface AnnotationState {
  /** Active strokes ordered by id (insertion). */
  strokes: StrokeSnapshot[];
  /** Applied ops (not undone). */
  past: Op[];
  /** Undone ops (redoable). */
  future: Op[];
}

export const emptyState = (): AnnotationState => ({ strokes: [], past: [], future: [] });

function applyOp(s: AnnotationState, op: Op): void {
  switch (op.kind) {
    case "add":
      s.strokes.push(...op.strokes);
      break;
    case "remove":
      s.strokes = s.strokes.filter((st) => !op.snapshots.some((r) => r.id === st.id));
      break;
    case "replace":
      s.strokes = s.strokes.filter((st) => !op.removed.some((r) => r.id === st.id)).concat(op.added);
      break;
  }
}

function invertOp(op: Op): Op {
  switch (op.kind) {
    case "add":
      return { kind: "remove", snapshots: op.strokes };
    case "remove":
      return { kind: "add", strokes: op.snapshots };
    case "replace":
      return { kind: "replace", removed: op.added, added: op.removed };
  }
}

/** Applies ONE event to the state (local mutation — fold calls it in order). */
export function applyEvent(s: AnnotationState, e: AnnotationEvent): AnnotationState {
  let op: Op | null = null;
  switch (e.type) {
    case "stroke":
      op = { kind: "add", strokes: [{ id: e.id, color: e.color, width: e.width, points: e.points }] };
      break;
    case "laser":
    case "print":
      break; // outside the geometric state (log/context only)
    case "erase":
      op =
        e.mode === "stroke"
          ? { kind: "remove", snapshots: e.snapshots }
          : { kind: "replace", removed: e.removed, added: e.added };
      break;
    case "clear":
      op = { kind: "remove", snapshots: e.snapshots };
      break;
    case "undo": {
      const last = s.past.pop();
      if (!last) break;
      s.future.push(last);
      applyOp(s, invertOp(last));
      return s;
    }
    case "redo": {
      const next = s.future.pop();
      if (!next) break;
      s.past.push(next);
      applyOp(s, next);
      return s;
    }
  }
  if (!op) return s;
  applyOp(s, op);
  s.past.push(op);
  s.future = []; // new geometric action invalidates redo (editor semantics)
  return s;
}

/** State at any point of the log — deterministic replay. */
export function foldEvents(events: AnnotationEvent[]): AnnotationState {
  const s = emptyState();
  for (const e of events) applyEvent(s, e);
  return s;
}

// ── geometry (used by the renderer when CREATING events; tested here) ─────────

/** Decimation: drops points closer than minPx to the last kept one (end always kept). */
export function simplifyPoints(points: Pt[], minPx = 3): Pt[] {
  if (points.length <= 2) return points;
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minPx) out.push(p);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Point→segment distance (eraser hit-test). */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Stroke-mode eraser: whole strokes touched by the path (within radius).
 * Hit-test against SEGMENTS (strokes are decimated — the middle of a long
 * stroke has no point of its own). */
export function hitStrokes(
  strokes: StrokeSnapshot[],
  path: Pt[],
  radius: number,
): StrokeSnapshot[] {
  return strokes.filter((st) => {
    const pts = st.points;
    if (pts.length === 1) {
      return path.some((q) => Math.hypot(pts[0]!.x - q.x, pts[0]!.y - q.y) <= radius);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (path.some((q) => distToSegment(q, a, b) <= radius)) return true;
    }
    return false;
  });
}

/** Does the stroke point hit the eraser path? (against points AND segments) */
function nearPath(p: Pt, path: Pt[], radius: number): boolean {
  if (path.length === 1) return Math.hypot(p.x - path[0]!.x, p.y - path[0]!.y) <= radius;
  if (path.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= radius)) return true;
  return path.some((q, i) => {
    if (i + 1 >= path.length) return false;
    return distToSegment(p, q, path[i + 1]!) <= radius;
  });
}

/**
 * Normal-mode eraser: removes stroke pieces within the path radius and
 * returns the leftover pieces ({removed, added}) ready for the erase-area
 * event. Pieces with < 2 points are dropped along the way.
 * Quickly drawn strokes (sparse points) are covered: beyond the original
 * points, each segment is sampled at its middle to detect crossing.
 */
export function splitStrokesByPath(
  strokes: StrokeSnapshot[],
  path: Pt[],
  radius: number,
  idFor: (strokeId: string, pieceIdx: number) => string,
): { removed: StrokeSnapshot[]; added: StrokeSnapshot[] } {
  const removed: StrokeSnapshot[] = [];
  const added: StrokeSnapshot[] = [];
  for (const st of strokes) {
    const pts = st.points;
    // 1) marking: touched original points + interior segment samples
    const marked = pts.map((p) => nearPath(p, path, radius));
    for (let i = 0; i + 1 < pts.length; i++) {
      if (marked[i] || marked[i + 1]) continue;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ms: (a.ms + b.ms) / 2 };
      // long segment: samples the middle (and quarters, if very long)
      const samples = Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / radius));
      let hitMid = false;
      for (let k = 1; k <= samples; k++) {
        const t = k / (samples + 1);
        const sp = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), ms: mid.ms };
        if (nearPath(sp, path, radius)) {
          hitMid = true;
          break;
        }
      }
      // crossed the segment without touching endpoints: cuts at the MIDDLE of
      // the segment — pieces keep the original points; the cut discards the piece.
      if (hitMid) {
        // inserts a cut: treats the segment's end point as marked
        // (approximation ≤ half the segment; undo restores the originals)
        marked[i + 1] = true;
      }
    }
    if (!marked.some(Boolean)) continue;

    // 2) splits into runs of unmarked points (>= 2 points)
    const runs: Pt[][] = [];
    let cur: Pt[] = [];
    pts.forEach((p, i) => {
      if (marked[i]) {
        if (cur.length >= 2) runs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    });
    if (cur.length >= 2) runs.push(cur);

    removed.push(st);
    runs.forEach((run, i) => {
      added.push({ id: idFor(st.id, i), color: st.color, width: st.width, points: run });
    });
  }
  return { removed, added };
}
