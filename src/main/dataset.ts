/**
 * voice-dictation training dataset access (W2a — issue #3).
 *
 * The corpus at %LOCALAPPDATA%\voice-dictation\datasets\ is the spec: reads and
 * writes in the SAME layout (transcriptions/YYYY-MM-DD/<id>.json, words
 * {w,start,end,p}, correction in the validation block). It's the same body the
 * JSONL export (voice-export) consumes.
 *
 * Hard rules (real training data):
 * - writes ALWAYS atomic (tmp + rename) — never truncate/overwrite in place;
 * - the original `text` is NEVER changed — the correction goes in the validation block;
 * - fail-soft: without a datasets dir, functions return "ausente"/[] without throwing;
 * - ids with separators/traversal are rejected (history.py guard).
 *
 * No electron — directly testable with a tmp fixture.
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

/** Voice dataset root (override VOICECAST_DATASET_DIR; null = unavailable). */
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

/** Readable corpus JSON with an id — same criterion as history._load_json. */
function loadJson(file: string): CorpusMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusMeta;
    if (typeof meta !== "object" || meta === null || !meta.id) return null;
    return meta;
  } catch {
    return null; // unreadable json ignored (panel parity)
  }
}

function preview(meta: CorpusMeta): string {
  return String(meta.text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Lists the corpus history (newest first, parity with
 * history.list_transcriptions): case-insensitive substring search on the text,
 * filter by labeled. Direct scan of the JSONs — no index (same as the panel).
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
 * Full detail of a corpus item (whole meta — words/quality/
 * validation — like history.get_detail) + file:// URL of the wav when it exists.
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
    file = matches.length ? matches[matches.length - 1] : null; // last day (parity)
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

/** Atomic write (tmp + rename) — the corrections.py pattern. */
function atomicWriteJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export type DatasetWriteStatus = "ok" | "ausente" | "erro";

/**
 * Writes a corpus item's correction: reads the JSON, adds the
 * `validation` block (original text/words untouched) and rewrites with tmp+rename.
 * Idempotent: reapplying overwrites the previous validation (same as the panel).
 */
export function writeDatasetCorrection(
  id: string,
  correctedText: string,
  edits: CorrectionEdit[],
  opts: { root?: string | null; labeledBy?: string; now?: Date } = {},
): DatasetWriteStatus {
  const root = opts.root ?? datasetRoot();
  if (!root) return "ausente"; // fail-soft: without a datasets dir, nothing is written
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
    logError(`dataset: scan failed for ${id}:`, e);
    return "erro";
  }
  if (!file) return "ausente";
  const meta = loadJson(file);
  if (!meta) {
    logError(`dataset: unreadable JSON, correction aborted: ${file}`);
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
    logError(`dataset: failed to write correction at ${file}:`, e);
    return "erro";
  }
  logInfo(`dataset: correction applied to ${id} (${cleanEdits.length} edits)`);
  return "ok";
}
