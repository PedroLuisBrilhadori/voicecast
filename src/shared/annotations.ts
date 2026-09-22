/**
 * Motor PURO das anotações em tela (PLANO-ANOTACOES-TELA, AN.2) — sem
 * electron, usado pelo main (escrita/replay do log), pelo renderer
 * (redesenho a partir do mesmo fold) e pelos testes.
 *
 * Princípios:
 *  - O LOG é a fonte da verdade (`annotations.jsonl`); o estado é fold dele.
 *  - Cada evento geométrico carrega o suficiente para INVERTER-se (undo) —
 *    inclusive a borracha por área, que grava o resultado da divisão
 *    (removed/added) em vez de recomputar geometria no replay.
 *  - Undo/redo também são eventos do log: o replay é determinístico.
 *  - Nova ação geométrica limpa o redo (semântica de editor); o log mantém
 *    tudo — o replay reproduz exatamente o que o usuário fez.
 *  - Coordenadas em px FÍSICOS (DPI 1.53 — lição F0); `ms` relativo ao
 *    início do stroke (timestamps de captura), `t` relativo à sessão.
 */

export type AnnotationTool = "laser" | "brush" | "eraser";
export type EraserMode = "stroke" | "area";

/** Ponto de um traço/laser: px físicos + ms relativo ao primeiro ponto. */
export interface Pt {
  x: number;
  y: number;
  ms: number;
}

/** Um traço ativo (ou o pedaço que sobrou de uma divisão). id: "18" | "18.0"… */
export interface StrokeSnapshot {
  id: string;
  color: string;
  width: number;
  points: Pt[];
}

export type AnnotationEvent =
  | { t: number; seq: number; type: "stroke"; id: string; color: string; width: number; points: Pt[] }
  /** Laser: caminho persistido no log (atenção), visual efêmero no renderer. */
  | { t: number; seq: number; type: "laser"; points: Pt[] }
  /** Borracha modo traço: remove strokes inteiros (restauráveis). */
  | { t: number; seq: number; type: "erase"; mode: "stroke"; snapshots: StrokeSnapshot[] }
  /** Borracha modo normal: resultado da divisão gravado (removed saiu, added ficou). */
  | { t: number; seq: number; type: "erase"; mode: "area"; removed: StrokeSnapshot[]; added: StrokeSnapshot[] }
  | { t: number; seq: number; type: "clear"; snapshots: StrokeSnapshot[] }
  | { t: number; seq: number; type: "undo" }
  | { t: number; seq: number; type: "redo" }
  /** Print queimado gerado pelo sistema (marker/auto-print/manual). */
  | { t: number; seq: number; type: "print"; kind: "marker" | "auto" | "manual"; file: string; strokes: string[] };

// ── fold do log → estado ──────────────────────────────────────────────────

/** Operação aplicada (invertível) — derivada dos eventos geométricos. */
type Op =
  | { kind: "add"; strokes: StrokeSnapshot[] }
  | { kind: "remove"; snapshots: StrokeSnapshot[] }
  | { kind: "replace"; removed: StrokeSnapshot[]; added: StrokeSnapshot[] };

export interface AnnotationState {
  /** Traços ativos ordenados por id (inserção). */
  strokes: StrokeSnapshot[];
  /** Ops aplicadas (não desfeitas). */
  past: Op[];
  /** Ops desfeitas (refazíveis). */
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

/** Aplica UM evento ao estado (mutação local — fold chama em ordem). */
export function applyEvent(s: AnnotationState, e: AnnotationEvent): AnnotationState {
  let op: Op | null = null;
  switch (e.type) {
    case "stroke":
      op = { kind: "add", strokes: [{ id: e.id, color: e.color, width: e.width, points: e.points }] };
      break;
    case "laser":
    case "print":
      break; // fora do estado geométrico (log/contexto apenas)
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
  s.future = []; // nova ação geométrica invalida o redo (semântica de editor)
  return s;
}

/** Estado em qualquer ponto do log — replay determinístico. */
export function foldEvents(events: AnnotationEvent[]): AnnotationState {
  const s = emptyState();
  for (const e of events) applyEvent(s, e);
  return s;
}

// ── geometria (usada pelo renderer ao CRIAR eventos; testada aqui) ─────────

/** Decimação: descarta pontos a < minPx do último mantido (fim sempre mantido). */
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

/** Distância ponto→segmento (hit-test da borracha). */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Borracha modo traço: strokes inteiros tocados pelo caminho (within radius).
 * Hit-test contra SEGMENTOS (strokes são decimados — o meio de um traço longo
 * não tem ponto próprio). */
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

/** Ponto do stroke pega o caminho da borracha? (contra pontos E segmentos) */
function nearPath(p: Pt, path: Pt[], radius: number): boolean {
  if (path.length === 1) return Math.hypot(p.x - path[0]!.x, p.y - path[0]!.y) <= radius;
  if (path.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= radius)) return true;
  return path.some((q, i) => {
    if (i + 1 >= path.length) return false;
    return distToSegment(p, q, path[i + 1]!) <= radius;
  });
}

/**
 * Borracha modo normal: remove trechos do stroke dentro do raio do caminho e
 * devolve os pedaços que sobraram ({removed, added}) prontos para o evento
 * erase-area. Pedaços com < 2 pontos são descartados junto.
 * Strokes desenhados rápido (pontos esparsos) são cobertos: além dos pontos
 * originais, cada segmento é amostrado no meio p/ detectar cruzamento.
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
    // 1) marcação: pontos originais tocados + amostras interiores de segmentos
    const marked = pts.map((p) => nearPath(p, path, radius));
    for (let i = 0; i + 1 < pts.length; i++) {
      if (marked[i] || marked[i + 1]) continue;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ms: (a.ms + b.ms) / 2 };
      // segmento longo: amostra o meio (e quartos, se for muito longo)
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
      // cruzou o segmento sem tocar endpoints: corta NO MEIO do segmento —
      // os pedaços ficam com os pontos originais; o corte descarta o trecho.
      if (hitMid) {
        // insere um corte: trata o ponto final do segmento como marcado
        // (aproximação ≤ metade do segmento; undo restaura os originais)
        marked[i + 1] = true;
      }
    }
    if (!marked.some(Boolean)) continue;

    // 2) divide em runs de pontos não marcados (>= 2 pontos)
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
