/**
 * Lógica pura dos segmentos do editor (fase B) — sem electron, testável.
 * Segmento = trecho nomeado da sessão; clipe e contexto nascem daqui.
 */

export interface SessionSegment {
  id: string;
  label: string;
  inS: number;
  outS: number;
}

/** Palavra com timing (subset do transcript — basta start/end p/ fatiar). */
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
 * Valida/normaliza segmentos vindos do renderer ou do meta.json: descarta
 * entradas sem sentido, clampa em 0, exige ≥0.2s, deduplica ids e ordena
 * por inS. Retorna sempre um array novo e seguro de persistir.
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
          : `Segmento ${out.length + 1}`,
      inS: +lo.toFixed(2),
      outS: +hi.toFixed(2),
    });
  }
  return out.sort((x, y) => x.inS - y.inS);
}

const safeNamePart = (s: string) => s.replace(/[^\w.-]+/g, "-").slice(0, 60);

/** Base do nome do clipe de um trecho (mesmo critério do createClip). */
export function clipFileBase(label: string, inS: number, outS: number): string {
  return `${safeNamePart(label) || "trecho"}-${Math.round(inS)}s-${Math.round(outS)}s`;
}

/** Base do nome do corte combinado (exportCut) — determinístico p/ re-export. */
export function cutFileBase(label: string, nSegments: number): string {
  return `${safeNamePart(label) || "corte"}-${nSegments}seg`;
}

/** Palavras que tocam o intervalo [inS, outS) — fatia de transcrição do trecho. */
export function wordsInRange<T extends TimedWord>(words: T[], inS: number, outS: number): T[] {
  return words.filter((w) => w.end > inS && w.start < outS);
}
