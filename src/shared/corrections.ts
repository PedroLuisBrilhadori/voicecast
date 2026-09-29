/**
 * Motor PURO da correção de ditados (W2a — issues #3+#5) — sem electron.
 *
 * O schema é o CORPUS do voice-dictation (não existe spec escrita — o disco
 * manda): `datasets/transcriptions/YYYY-MM-DD/<HHMMSS-hash8>.json` com words
 * `{w, start, end, p}` e correção no bloco `validation` gravado no PRÓPRIO
 * JSON (paridade com voice/corrections.py do painel :8700):
 *
 *   "validation": {
 *     "corrected_text": "…texto final corrigido…",
 *     "ts": "2026-08-27T12:00:00",
 *     "n_edits": 1,
 *     "edits": [{"index": 3, "original_w": "notch", "corrected_w": "note"}],
 *     "labeled_by": "voicecast"
 *   }
 *
 * O campo original `text` NUNCA é alterado no corpus — o par (raw, corrected)
 * é o dado de treino. No voicecast (transcript.json da sessão) as palavras SÃO
 * editadas no lugar, preservando timings.
 */
import path from "node:path";

/** Palavra do transcript/corpus com timing e confiança. */
export interface TimedWord {
  w: string;
  start: number;
  end: number;
  p: number;
}

/** Marcação palavra a palavra vinda da UI (mesmo shape do painel antigo). */
export interface CorrectionEdit {
  /** posição no token stream (index em words). */
  index: number;
  originalW: string;
  correctedW: string;
}

/** Bloco validation gravado no JSON do corpus (mesma schema do voice). */
export interface ValidationBlock {
  corrected_text: string;
  ts: string;
  n_edits: number;
  edits: CorrectionEdit[];
  labeled_by: string;
}

/**
 * Valida/normaliza edições vindas do renderer — mesma política do
 * voice/corrections.py: index inteiro ≥ 0, corrected_w não vazio (correção
 * vazia é descartada), original_w string (default ""). Retorna array novo.
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

/** Texto a partir das palavras (mesma normalização do buildContext). */
export function wordsText(words: TimedWord[]): string {
  return words
    .map((w) => w.w)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aplica edições NAS PALAVRAS (sem tocar em start/end/p) e recompõe o texto.
 * Edições fora do range são ignoradas. Retorna arrays/objetos novos — o
 * original nunca é mutado.
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

/** ts no formato do corpus: ISO local com precisão de segundos (sem Z). */
export function corpusTs(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** Bloco validation pronto p/ gravar no corpus (labeled_by identifica quem rotulou). */
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
 * Guarda de segurança do id do corpus (paridade com history.find_item_path):
 * rejeita separators/traversal — ids são `HHMMSS-hash8`.
 */
export function isValidItemId(id: string): boolean {
  return Boolean(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

/** Raiz do dataset do voice: override por env, senão %LOCALAPPDATA% do voice-dictation. */
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

// ── rewrite completo (modo texto do editor) ────────────────────

/** nº de edições palavra-a-palavra entre o cru do ASR e o corrigido
 *  (Levenshtein por palavras — substituição custa 1, alinhado ao modelo
 *  edits[] do corrections.py). */
export function diffWordCount(before: string, after: string): number {
  const a = before.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const b = after.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  // textos de ditado são curtos (≤ centenas de palavras) — O(n·m) ok
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
 * Redistribui o texto corrigido sobre os timings antigos (proporcional à
 * duração por palavra): o rewrite perde o alinhamento 1:1 do ASR, mas cada
 * palavra nova ganha um slot temporal coerente com a fala original.
 */
export function redistributeWords(oldWords: TimedWord[], corrected: string): TimedWord[] {
  const text = corrected.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const newWords = text.split(" ");
  if (!oldWords.length) {
    // sem referência temporal: tudo em t=0 (ditados do gancho fake/antigos)
    return newWords.map((w) => ({ w, start: 0, end: 0, p: 1 }));
  }
  const t0 = oldWords[0]!.start;
  const t1 = Math.max(...oldWords.map((w) => w.end), oldWords[0]!.end);
  const span = Math.max(0.1, t1 - t0);
  const per = span / newWords.length;
  return newWords.map((w, i) => ({ w, start: +(t0 + i * per).toFixed(3), end: +(t0 + (i + 1) * per).toFixed(3), p: 1 }));
}
