/**
 * Resumo das marcações de uma sessão para o buildContext (AN.4 do
 * PLANO-ANOTACOES-TELA) — PURO, sem electron: recebe o conteúdo do
 * `annotations.jsonl` e os PNGs existentes em `frames/` e devolve as linhas
 * da seção "Anotações (N):". `library.ts` só consome.
 *
 * Contrato:
 *  - Tempos do jsonl são relativos ao `startedAt` real da sessão → formatados
 *    com fmtTs (m:ss), como as outras seções do contexto.
 *  - Print queimado "correspondente": o evento `print` carrega o arquivo
 *    (`frames/<nome>.png`) e os ids dos strokes queimados; o path só entra na
 *    linha se o PNG existir em `frames/` (readdir do caller — tolerante a não
 *    achar, a linha sai sem path).
 *  - O fold do motor puro (`foldEvents`) decide o que sobreviveu: stroke que
 *    não está no estado final sai marcado "(apagado)" (apagado/limpado/desfeito).
 *  - Jsonl vazio/sem eventos → null (seção não aparece — mesmo comportamento
 *    da seção Trechos).
 */
import { foldEvents, type AnnotationEvent } from "./annotations";
import { wslPathQuoted } from "./paths";

/** Tempo relativo m:ss — mesmo formato das outras seções do buildContext.
 * Arredonda o TOTAL antes de quebrar (W2b): 59.7 vira "1:00", não "0:60". */
export function fmtTs(s: number): string {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Uma marcação citada na seção. */
export interface AnnotationMark {
  /** t relativo à sessão (s), como gravado no jsonl. */
  t: number;
  /** Rótulo pt-BR do tipo (laser, pincel, borracha…, print (marker)…). */
  kind: string;
  /** PNG queimado correspondente (basename presente em frames/), se houver. */
  print?: string;
  /** Stroke que não sobreviveu ao estado final do log (apagado/desfeito). */
  gone?: boolean;
}

export interface AnnotationSummary {
  marks: AnnotationMark[];
  /** Strokes ativos no estado final (fold do log completo). */
  activeStrokes: number;
  /** Linhas corrompidas/ilegíveis puladas (contexto é best-effort). */
  skipped: number;
}

/** Seção pronta para o buildContext. */
export interface AnnotationSection extends AnnotationSummary {
  /** nº de marcações citadas (= marcações incluídas no contexto). */
  count: number;
  /** Linhas de markdown (header + uma por marcação). */
  lines: string[];
}

/** Rótulo de exibição por tipo de evento (vocabulário do plano AN). */
function kindLabel(e: AnnotationEvent): string {
  switch (e.type) {
    case "stroke":
      return "pincel";
    case "laser":
      return "laser";
    case "erase":
      return e.mode === "stroke" ? "borracha (traço)" : "borracha (área)";
    case "clear":
      return "limpar";
    case "undo":
      return "desfazer";
    case "redo":
      return "refazer";
    case "print":
      return `print (${e.kind})`;
  }
}

const basename = (f: string): string => f.split(/[\\/]/).pop() ?? f;

/** Jsonl → eventos (linhas vazias/corrompidas puladas, contadas em skipped). */
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
 * Agrega o jsonl da sessão em marcações citáveis. Retorna null quando não há
 * evento nenhum (seção some do contexto).
 */
export function summarizeAnnotationEvents(
  jsonl: string,
  frameFiles: readonly string[],
): AnnotationSummary | null {
  const { events, skipped } = parseEvents(jsonl);
  if (!events.length) return null;

  const existing = new Set(frameFiles);
  // stroke id → print queimado que o inclui (primeiro por ordem do log cujo
  // PNG existe — marker/auto queimam os strokes ativos no instante)
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
 * Seção completa: linhas prontas para o `lines.push(...)` do buildContext.
 * Null quando não há marcações (caller não emite nada — nem a seção nem o
 * counter).
 */
export function annotationSection(
  jsonl: string,
  frameFiles: readonly string[],
  framesDir: string,
): AnnotationSection | null {
  const s = summarizeAnnotationEvents(jsonl, frameFiles);
  if (!s || !s.marks.length) return null;
  const dir = framesDir.replace(/[\\/]+$/, "");
  const lines: string[] = [`Anotações (${s.marks.length}):`];
  s.marks.forEach((m, i) => {
    lines.push(`${i + 1}. ${fmtTs(m.t)} ${m.kind}${m.gone ? " (apagado)" : ""}`);
    if (m.print) lines.push(`   Print: ${wslPathQuoted(`${dir}/${m.print}`)}`);
  });
  return { ...s, count: s.marks.length, lines };
}
