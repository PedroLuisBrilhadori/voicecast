/**
 * Acesso ao dataset de treino do voice-dictation (W2a — issue #3).
 *
 * O corpus em %LOCALAPPDATA%\voice-dictation\datasets\ é a spec: leitura e
 * escrita no MESMO layout (transcriptions/YYYY-MM-DD/<id>.json, words
 * {w,start,end,p}, correção no bloco validation). É o mesmo corpo que o
 * export JSONL (voice-export) consome.
 *
 * Regras duras (dado real de treino):
 * - escrita SEMPRE atômica (tmp + rename) — nunca truncar/reescriver por cima;
 * - o `text` original NUNCA é alterado — a correção entra no bloco validation;
 * - fail-soft: sem datasets dir, as funções devolvem "ausente"/[] sem lançar;
 * - ids com separators/traversal são rejeitados (guard do history.py).
 *
 * Sem electron — testável direto com fixture em tmp.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildValidation,
  datasetRootFrom,
  isValidItemId,
  sanitizeEdits,
  type CorrectionEdit,
  type TimedWord,
  type ValidationBlock,
} from "../shared/corrections";
import type { DatasetItemDetail, DatasetItemSummary } from "../shared/ipc";
import { logError, logInfo } from "./logging";

/** Raiz do dataset do voice (override VOICECAST_DATASET_DIR; null = indisponível). */
export function datasetRoot(): string | null {
  return datasetRootFrom(process.env);
}

interface CorpusMeta {
  id?: string;
  ts?: string;
  text?: string;
  duration_s?: number;
  source?: string;
  language?: string;
  model?: string;
  words?: TimedWord[];
  audio?: string;
  validation?: ValidationBlock | null;
  [k: string]: unknown;
}

/** JSON do corpus legível e com id — mesmo critério do history._load_json. */
function loadJson(file: string): CorpusMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusMeta;
    if (typeof meta !== "object" || meta === null || !meta.id) return null;
    return meta;
  } catch {
    return null; // json ilegível ignorado (paridade com o painel)
  }
}

function preview(meta: CorpusMeta): string {
  return String(meta.text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Lista o histórico do corpus (mais recente primeiro, paridade com
 * history.list_transcriptions): busca case-insensitive por substring no texto,
 * filtro por rotuladas. Scan direto dos JSONs — sem índice (igual ao painel).
 */
export function listDatasetItems(
  opts: {
    root?: string | null;
    query?: string;
    labeled?: "any" | "0" | "1";
    limit?: number;
  } = {},
): DatasetItemSummary[] {
  const root = opts.root ?? datasetRoot();
  if (!root) return [];
  const trDir = path.join(root, "transcriptions");
  if (!fs.existsSync(trDir)) return [];
  const q = (opts.query ?? "").trim().toLowerCase();
  const labeled = opts.labeled ?? "any";
  const out: DatasetItemSummary[] = [];
  let dayDirs: string[] = [];
  try {
    dayDirs = fs
      .readdirSync(trDir)
      .filter((d) => fs.statSync(path.join(trDir, d)).isDirectory())
      .sort()
      .reverse();
  } catch {
    return [];
  }
  for (const day of dayDirs) {
    const dayDir = path.join(trDir, day);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dayDir).filter((f) => f.endsWith(".json")).sort().reverse();
    } catch {
      continue;
    }
    for (const f of files) {
      const meta = loadJson(path.join(dayDir, f));
      if (!meta) continue;
      const validated = Boolean(meta.validation);
      if (labeled === "0" && validated) continue;
      if (labeled === "1" && !validated) continue;
      const prev = preview(meta);
      if (q && !prev.toLowerCase().includes(q) && !String(meta.id).includes(q)) continue;
      out.push({
        id: String(meta.id),
        ts: meta.ts ?? null,
        preview: prev,
        durationS: typeof meta.duration_s === "number" ? meta.duration_s : null,
        source: meta.source ?? null,
        language: meta.language ?? null,
        validated,
      });
      if (out.length >= (opts.limit ?? 200)) return out;
    }
  }
  return out;
}

/**
 * Detalhe completo de um item do corpus (meta inteiro — words/quality/
 * validation — como history.get_detail) + URL file:// do wav quando existe.
 */
export function getDatasetItem(
  id: string,
  root: string | null = datasetRoot(),
): DatasetItemDetail | null {
  if (!root || !isValidItemId(id)) return null;
  const trDir = path.join(root, "transcriptions");
  if (!fs.existsSync(trDir)) return null;
  let file: string | null = null;
  try {
    const matches = fs
      .readdirSync(trDir)
      .filter((d) => fs.statSync(path.join(trDir, d)).isDirectory())
      .sort()
      .map((d) => path.join(trDir, d, `${id}.json`))
      .filter((p) => fs.existsSync(p));
    file = matches.length ? matches[matches.length - 1] : null; // último dia (paridade)
  } catch {
    return null;
  }
  if (!file) return null;
  const meta = loadJson(file);
  if (!meta) return null;
  const wav = meta.audio ? path.join(root, String(meta.audio)) : null;
  const hasWav = wav ? fs.existsSync(wav) : false;
  return {
    id: String(meta.id),
    ts: meta.ts ?? null,
    text: String(meta.text ?? ""),
    durationS: typeof meta.duration_s === "number" ? meta.duration_s : null,
    source: meta.source ?? null,
    language: meta.language ?? null,
    model: meta.model ?? null,
    words: Array.isArray(meta.words) ? meta.words : [],
    validation: meta.validation ?? null,
    audioUrl:
      wav && hasWav ? "file:///" + wav.replace(/\\/g, "/") : null,
  };
}

/** Escrita atômica (tmp + rename) — o padrão do corrections.py. */
function atomicWriteJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export type DatasetWriteStatus = "ok" | "ausente" | "erro";

/**
 * Grava a correção de um item do corpus: lê o JSON, adiciona o bloco
 * `validation` (text/words originais intocados) e regrava com tmp+rename.
 * Idempotente: reaplicar sobrescreve o validation anterior (igual ao painel).
 */
export function writeDatasetCorrection(
  id: string,
  correctedText: string,
  edits: CorrectionEdit[],
  opts: { root?: string | null; labeledBy?: string; now?: Date } = {},
): DatasetWriteStatus {
  const root = opts.root ?? datasetRoot();
  if (!root) return "ausente"; // fail-soft: sem datasets dir, nada é escrito
  if (!isValidItemId(id)) return "ausente";
  const trDir = path.join(root, "transcriptions");
  if (!fs.existsSync(trDir)) return "ausente";
  let file: string | null = null;
  try {
    const matches = fs
      .readdirSync(trDir)
      .filter((d) => fs.statSync(path.join(trDir, d)).isDirectory())
      .sort()
      .map((d) => path.join(trDir, d, `${id}.json`))
      .filter((p) => fs.existsSync(p));
    file = matches.length ? matches[matches.length - 1] : null;
  } catch (e) {
    logError(`dataset: scan falhou p/ ${id}:`, e);
    return "erro";
  }
  if (!file) return "ausente";
  const meta = loadJson(file);
  if (!meta) {
    logError(`dataset: JSON ilegível, correção abortada: ${file}`);
    return "erro";
  }
  const cleanEdits = sanitizeEdits(edits);
  const validation = buildValidation(
    correctedText,
    cleanEdits,
    opts.now ?? new Date(),
    opts.labeledBy ?? "voicecast",
  );
  try {
    atomicWriteJson(file, { ...meta, validation });
  } catch (e) {
    logError(`dataset: falha ao gravar correção em ${file}:`, e);
    return "erro";
  }
  logInfo(`dataset: correção aplicada em ${id} (${cleanEdits.length} edições)`);
  return "ok";
}
