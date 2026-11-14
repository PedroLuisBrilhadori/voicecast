/**
 * Session post-processing: automatic transcription, clips, frames, and
 * agent context generation ("Copiar para o ZCode").
 */
import { clipboard } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asrHealth, transcribeSession, type Transcript } from "./asr";
import { judgeSession, type DictationJudgment } from "./jev";
import { resolveFfmpeg, runFfmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";
import { sessionDirs, sessionsRoot } from "./storage";
import { sessionDirName, wslPathQuoted } from "../shared/paths";
import type { ClipInfo, CorrectionEdit, CorrectionResult, DatasetWriteStatus, SessionMetaPatch, SessionSegment } from "../shared/ipc";
import { clipFileBase, cutFileBase, sanitizeSegments, wordsInRange } from "../shared/segments";
import { annotationSection, fmtTs } from "../shared/annotations-context";
import {
  applyEditsToWords,
  diffWordCount,
  redistributeWords,
  sanitizeEdits,
  wordsText,
} from "../shared/corrections";
import { writeDatasetCorrection } from "./dataset";
import { counter, histogram, withSpan } from "./telemetry";

// voicecast_sessions_total belongs to capture.ts (which emits it); duplicating it here caused
// confusion — with the lazy core it would land on the same instrument, but it lives in one place only
const M_TRANSCRIBE = counter("voicecast_transcriptions_total", "transcriptions by status");
const H_TRANSCRIBE = histogram("voicecast_transcribe_seconds", "ASR transcription duration");
const M_CUT = counter("voicecast_cuts_total", "combined cuts by outcome");
const H_CUT = histogram("voicecast_cut_seconds", "combined cut duration (exportCut)");
// AN.4: number of screen markers cited in the context (only emits when present — a session without
// annotations generates neither section nor metric)
const M_CTX_ANNOTATIONS = counter(
  "voicecast_context_annotations_total",
  "screen markers included in buildContext",
);
// W2a: dictation corrections by target (voicecast | dataset | both)
const M_CORRECTIONS = counter("voicecast_corrections_total", "dictation corrections by target");

// ── library types ────────────────────────────────────────

export interface SessionSummary {
  dir: string; // YYYY-MM-DD
  name: string; // hhmm-hash
  status: string;
  startedAt: string | null;
  durationS: number | null;
  mode: string | null;
  sourceLabel: string | null;
  title: string | null;
  tags: string[];
  sizeBytes: number | null;
  hasMp4: boolean;
  hasTranscript: boolean;
  transcriptStatus: string | null;
  thumb: string | null; // Windows path of the thumb (or null)
  markers: number[];
  /** First words of the transcript (card subtitle). */
  preview: string | null;
}

/** Jev judgment stored in meta.json (PLANO-JEV-CU step 2). */
export interface JevMeta {
  model: string;
  judgedAt: string;
  rota?: string;
  conf?: number;
  relevancia?: number;
  pedido?: number;
  risco?: number;
}

interface Meta {
  status?: string;
  startedAt?: string;
  durationS?: number;
  mode?: string;
  sourceLabel?: string;
  title?: string;
  tags?: string[];
  sizeBytes?: number;
  markers?: number[];
  transcriptStatus?: string;
  /** Named segments from the editor (phase B) — always sanitized before writing. */
  segments?: SessionSegment[];
  /** Dictation: first sentence of the transcript (automatic title). */
  textPreview?: string;
  /** Jev judgment (fail-soft: absent when off/no key/error). */
  jev?: JevMeta;
  /** W2a: id of the matching item in the voice corpus (optional link). */
  datasetId?: string;
  /** W2a: last correction written in this session. */
  correction?: SessionCorrectionMeta;
}

// ── library ─────────────────────────────────────────────────

export function listSessions(): SessionSummary[] {
  const root = sessionsRoot();
  const out: SessionSummary[] = [];
  if (!fs.existsSync(root)) return out;
  for (const day of fs.readdirSync(root)) {
    const dayPath = path.join(root, day);
    if (!fs.statSync(dayPath).isDirectory()) continue;
    for (const name of fs.readdirSync(dayPath)) {
      const metaPath = path.join(dayPath, name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Meta;
        const dirs = sessionDirs(day, name);
        const transcriptPath = dirs.transcript;
        const hasTranscript = fs.existsSync(transcriptPath);
        const preview = hasTranscript
          ? (JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript).text
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120)
          : null;
        out.push({
          dir: day,
          name,
          status: m.status ?? "?",
          startedAt: m.startedAt ?? null,
          durationS: m.durationS ?? null,
          mode: m.mode ?? null,
          sourceLabel: m.sourceLabel ?? null,
          title: m.title ?? null,
          tags: m.tags ?? [],
          sizeBytes: m.sizeBytes ?? null,
          hasMp4: fs.existsSync(dirs.mp4),
          hasTranscript,
          transcriptStatus: m.transcriptStatus ?? null,
          thumb: fs.existsSync(path.join(dirs.thumbs, "session.png"))
            ? path.join(dirs.thumbs, "session.png")
            : null,
          markers: m.markers ?? [],
          preview,
        });
      } catch {}
    }
  }
  out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return out;
}

/** Simple full-text search: title + transcript text + tags. */
export function searchSessions(query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  const all = listSessions();
  if (!q) return all;
  return all.filter(
    (s) =>
      `${s.title ?? ""} ${s.name} ${s.mode ?? ""} ${(s.tags ?? []).join(" ")} ${s.preview ?? ""}`
        .toLowerCase()
        .includes(q),
  );
}

export function getSessionDetail(
  dir: string,
  name: string,
): { meta: Meta; transcript: Transcript | null; mp4: string; audio: string | null } | null {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.meta)) return null;
  const meta = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
  const transcript = fs.existsSync(dirs.transcript)
    ? (JSON.parse(fs.readFileSync(dirs.transcript, "utf8")) as Transcript)
    : null;
  const audioFile = fs.existsSync(dirs.audio) ? dirs.audio : null;
  const videoFile = fs.existsSync(dirs.mp4) ? dirs.mp4 : null;
  if (!videoFile && !audioFile) return null;
  return { meta, transcript, mp4: videoFile ?? "", audio: audioFile };
}

/**
 * Persists a dictation as an audio session in the library (same layout).
 * `transcript: null` saves ONLY the audio (transcriptStatus "pending") — the speech
 * can't be discarded because the ASR was off/down; the editor's
 * "transcribe now" button recovers it later.
 */
export function saveDictationSession(
  startedAt: number,
  ext: string,
  audioB64: string,
  transcript: Transcript | null,
  jev?: DictationJudgment | null,
): { dir: string; name: string } {
  const now = new Date(startedAt);
  const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const name = sessionDirName(now, `${startedAt}:ditado:${Math.random()}`);
  const dirs = sessionDirs(dayDir, name);
  fs.mkdirSync(dirs.root, { recursive: true });

  fs.writeFileSync(dirs.audio, Buffer.from(audioB64, "base64"));
  if (transcript) fs.writeFileSync(dirs.transcript, JSON.stringify(transcript, null, 2));
  const preview = transcript?.text.replace(/\s+/g, " ").trim().slice(0, 60) ?? "";
  writeMeta(dirs.meta, {
    status: "finalizada",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationS: +((Date.now() - startedAt) / 1000).toFixed(1),
    mode: "ditado",
    sourceLabel: "mic",
    title: preview || "Dictation (no transcript)",
    textPreview: preview,
    transcriptStatus: transcript ? "done" : "pending",
    sizeBytes: fs.statSync(dirs.audio).size,
    ...(jev
      ? { jev: { model: jev.model, judgedAt: new Date().toISOString(), rota: jev.rota, conf: jev.confidence } }
      : {}),
  });
  logInfo(
    `dictation saved to the library: ${dayDir}/${name} "${preview}"` +
      (transcript ? "" : " — audio pending transcription (ASR unavailable at the moment)"),
  );
  return { dir: dayDir, name };
}

// ── transcription (called at session end and manually) ────────────

export async function transcribeAndStore(dir: string, name: string): Promise<boolean> {
  const dirs = sessionDirs(dir, name);
  // video session (mp4) OR dictation session (audio.webm) — re-transcribing a
  // saved dictation without speech depends on the audio, not the mp4
  const media = fs.existsSync(dirs.mp4) ? dirs.mp4 : fs.existsSync(dirs.audio) ? dirs.audio : null;
  if (!media) return false;
  const patch = (p: Partial<Meta>) => {
    const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
    writeMeta(dirs.meta, { ...m, ...p });
  };
  patch({ transcriptStatus: "pending" });
  // waits for the ASR host to open the port (the app-boot spawn takes seconds —
  // without this, --transcribe on cold start loses the race and marks sem-asr)
  const health = await asrHealth({ waitMs: 30_000 });
  if (!health.ok) {
    logError("ASR down — transcription will stay pending (re-transcribe later)");
    patch({ transcriptStatus: "sem-asr" });
    M_TRANSCRIBE?.add(1, { status: "sem-asr" });
    return false;
  }
  const t0 = Date.now();
  try {
    const t = await transcribeSession(media);
    fs.writeFileSync(dirs.transcript, JSON.stringify(t, null, 2));
    patch({ transcriptStatus: "done" });
    H_TRANSCRIBE?.record((Date.now() - t0) / 1000, { kind: "sessao" });
    M_TRANSCRIBE?.add(1, { status: "ok" });
    logInfo(`transcription ready: ${dir}/${name} (${t.words.length} words)`);

    // Step 2: session Jev judgment (fail-soft — judgment is an improvement,
    // not a dependency; a failure here doesn't affect the ready transcription)
    try {
      const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
      const j = await judgeSession(t.text, { mode: m.mode, title: m.title });
      if (j) {
        patch({
          jev: {
            model: j.model,
            judgedAt: new Date().toISOString(),
            rota: j.rota ?? undefined,
            conf: j.confidence || undefined,
            relevancia: j.relevancia ?? undefined,
            pedido: j.pedido ?? undefined,
            risco: j.risco ?? undefined,
          },
        });
        logInfo(
          `jev: ${dir}/${name} → route ${j.rota ?? "?"} · relevance ${j.relevancia?.toFixed(1) ?? "?"}/3 · ${j.latenciaMs.toFixed(0)}ms`,
        );
      }
    } catch (e) {
      logError("jev: session judgment failed (session intact):", e);
    }
    return true;
  } catch (e) {
    logError("transcription failed:", e);
    patch({ transcriptStatus: "erro" });
    M_TRANSCRIBE?.add(1, { status: "erro" });
    return false;
  }
}

function writeMeta(metaPath: string, meta: unknown): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ── clips and frames ────────────────────────────────────────────

export async function createClip(
  dir: string,
  name: string,
  inS: number,
  outS: number,
  label?: string,
): Promise<{ file: string; bytes: number } | { error: string }> {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return { error: "missing mp4" };
  fs.mkdirSync(dirs.clips, { recursive: true });
  const dest = path.join(dirs.clips, `${clipFileBase(label ?? "", inS, outS)}.mp4`);
  try {
    const ff = await resolveFfmpeg();
    // exact cut: light re-encode (cuts at any frame, not just keyframes)
    await runFfmpeg(ff, [
      "-y", "-ss", String(inS), "-i", dirs.mp4, "-to", String(Math.max(0.1, outS - inS)),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "96k",
      dest,
    ]);
    return { file: dest, bytes: fs.statSync(dest).size };
  } catch (e) {
    logError("clip failed:", e);
    return { error: String(e) };
  }
}

/** Existing .mp4 clips in clips/ — the editor's list (phase A wrote, didn't list). */
export function listClips(dir: string, name: string): ClipInfo[] {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.clips)) return [];
  const out: ClipInfo[] = [];
  for (const f of fs.readdirSync(dirs.clips)) {
    if (!f.endsWith(".mp4")) continue;
    try {
      const st = fs.statSync(path.join(dirs.clips, f));
      out.push({ file: path.join(dirs.clips, f), name: f, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Combined cut (phase B): re-cuts each segment (same encode as createClip —
 * identical params are a concat prerequisite) and joins into a single mp4 at
 * clips/<label>-<N>seg.mp4. Re-export overwrites (deterministic name).
 */
export async function exportCut(
  dir: string,
  name: string,
  segments: SessionSegment[],
  label = "corte",
): Promise<{ file: string; bytes: number } | { error: string }> {
  const segs = sanitizeSegments(segments);
  if (!segs.length) return { error: "no valid segments" };
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return { error: "missing mp4" };
  fs.mkdirSync(dirs.clips, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voicecast-cut-"));
  const t0 = Date.now();
  try {
    const ff = await resolveFfmpeg();
    const parts: string[] = [];
    for (const [i, s] of segs.entries()) {
      const part = path.join(tmp, `part-${String(i).padStart(3, "0")}.mp4`);
      await runFfmpeg(ff, [
        "-y", "-ss", String(s.inS), "-i", dirs.mp4, "-to", String(Math.max(0.1, s.outS - s.inS)),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "96k",
        part,
      ]);
      parts.push(part);
    }
    // concat demuxer: paths escaped for single quotes (ffmpeg's own syntax)
    const listFile = path.join(tmp, "list.txt");
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const dest = path.join(dirs.clips, `${cutFileBase(label, segs.length)}.mp4`);
    await runFfmpeg(ff, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", dest]);
    H_CUT?.record((Date.now() - t0) / 1000, { segments: String(segs.length) });
    M_CUT?.add(1, { status: "ok" });
    logInfo(`combined cut ready: ${dir}/${name} (${segs.length} segments)`);
    return { file: dest, bytes: fs.statSync(dest).size };
  } catch (e) {
    logError("cut failed:", e);
    M_CUT?.add(1, { status: "erro" });
    return { error: String(e) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function captureFrame(
  dir: string,
  name: string,
  atS: number,
): Promise<{ file: string } | { error: string }> {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return { error: "missing mp4" };
  fs.mkdirSync(dirs.frames, { recursive: true });
  const dest = path.join(dirs.frames, `frame-${String(Math.round(atS)).padStart(4, "0")}s.png`);
  try {
    const ff = await resolveFfmpeg();
    await runFfmpeg(ff, ["-y", "-ss", String(atS), "-i", dirs.mp4, "-frames:v", "1", dest]);
    return { file: dest };
  } catch (e) {
    return { error: String(e) };
  }
}

// ── agent context ──────────────────────────────────────

export interface ContextInput {
  dir: string;
  name: string;
  /** selected range (optional): filters the transcript and cites the clip */
  range?: { inS: number; outS: number } | null;
  includeFullTranscript?: boolean;
}

export async function buildContext(
  input: ContextInput,
): Promise<{ markdown: string } | { error: string }> {
  const detail = getSessionDetail(input.dir, input.name);
  if (!detail) return { error: "session not found" };
  const dirs = sessionDirs(input.dir, input.name);
  const { meta, transcript } = detail;
  const title = meta.title || `Session ${input.name}`;
  const dur = meta.durationS ? `${fmtTs(meta.durationS)}` : "?";

  const lines: string[] = [];
  lines.push(
    `### voicecast ${input.dir} ${input.name.slice(0, 4)} (${dur}) — ${title}${meta.mode === "ditado" ? " · dictation" : ""}`,
  );

  // main media
  if (fs.existsSync(dirs.mp4)) {
    lines.push(`Video: ${wslPathQuoted(dirs.mp4)}`);
  } else if (fs.existsSync(dirs.audio)) {
    lines.push(`Audio: ${wslPathQuoted(dirs.audio)}`);
  }

  // transcribed speech
  if (transcript) {
    const words = transcript.words ?? [];
    const inS = input.range?.inS ?? 0;
    const outS = input.range?.outS ?? Infinity;
    const sel = wordsInRange(words, inS, outS);
    const slice = sel.length ? sel : input.range ? [] : words;
    if (slice.length) {
      const text = slice.map((w) => w.w).join(" ").replace(/\s+/g, " ").trim();
      const from = input.range ? ` (${fmtTs(inS)}–${fmtTs(outS)})` : " (full)";
      lines.push(`Speech${from}: "${text}"`);
    }
  } else if (meta.transcriptStatus === "pending") {
    lines.push("Speech: (transcription in progress)");
  }

  // named segments (editor phase B): each segment's speech + clip when it exists
  const segs = meta.segments ?? [];
  if (segs.length) {
    lines.push(`Segments (${segs.length}):`);
    for (const [i, s] of segs.entries()) {
      const slice = transcript ? wordsInRange(transcript.words ?? [], s.inS, s.outS) : [];
      const text = slice.length
        ? slice.map((w) => w.w).join(" ").replace(/\s+/g, " ").trim()
        : "(no speech in the segment)";
      lines.push(`${i + 1}. ${s.label} (${fmtTs(s.inS)}–${fmtTs(s.outS)}): ${text ? `"${text}"` : text}`);
      const clip = path.join(dirs.clips, `${clipFileBase(s.label, s.inS, s.outS)}.mp4`);
      if (fs.existsSync(clip)) lines.push(`   Clip: ${wslPathQuoted(clip)}`);
    }
    const cut = path.join(dirs.clips, `${cutFileBase("corte", segs.length)}.mp4`);
    if (fs.existsSync(cut)) {
      lines.push(`Combined cut (${segs.length} segments): ${wslPathQuoted(cut)}`);
    }
  }

  // on-screen annotations (AN.4): jsonl markers + the matching burned-in shot
  // (path only when the PNG exists in frames/ — a line without a shot is normal)
  const annotationsJsonl = path.join(dirs.root, "annotations.jsonl");
  if (fs.existsSync(annotationsJsonl)) {
    const frameFiles = fs.existsSync(dirs.frames)
      ? fs.readdirSync(dirs.frames).filter((f) => f.endsWith(".png"))
      : [];
    const ann = annotationSection(
      fs.readFileSync(annotationsJsonl, "utf8"),
      frameFiles,
      dirs.frames,
    );
    if (ann) {
      lines.push(...ann.lines);
      M_CTX_ANNOTATIONS?.add(ann.count);
    }
  }

  // Jev judgment (step 2) — triage ready for the agent to consume
  if (meta.jev) {
    const partes: string[] = [];
    if (meta.jev.rota) partes.push(`route ${meta.jev.rota}${meta.jev.conf != null ? ` (conf ${meta.jev.conf.toFixed(2)})` : ""}`);
    if (meta.jev.relevancia != null) partes.push(`relevance ${meta.jev.relevancia.toFixed(1)}/3`);
    if (meta.jev.pedido != null) partes.push(`action-request ${meta.jev.pedido.toFixed(2)}`);
    if (meta.jev.risco != null) partes.push(`risk ${meta.jev.risco.toFixed(2)}`);
    if (partes.length) lines.push(`Judgment (Jev ${meta.jev.model}): ${partes.join(" · ")}`);
  }

  // clips and frames
  const clips = fs.existsSync(dirs.clips)
    ? fs.readdirSync(dirs.clips).filter((f) => f.endsWith(".mp4"))
    : [];
  if (clips.length) {
    lines.push(
      `Clips: ${clips.map((c) => wslPathQuoted(path.join(dirs.clips, c))).join(" · ")}`,
    );
  }
  const frames = fs.existsSync(dirs.frames)
    ? fs.readdirSync(dirs.frames).filter((f) => f.endsWith(".png"))
    : [];
  if (frames.length) {
    lines.push(
      `Shots: ${frames.map((f) => wslPathQuoted(path.join(dirs.frames, f))).join(" · ")}`,
    );
  }
  lines.push(`Session folder: ${wslPathQuoted(dirs.root)}`);
  lines.push("");
  lines.push(
    "Use the shots (PNG, read as images) and the video (MP4, read as video) to understand the visual context; the paths above are WSL.",
  );

  return { markdown: lines.join("\n") };
}

export function copyToClipboard(text: string): void {
  clipboard.writeText(text);
}

export function openInFolder(winPath: string): void {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  spawn("explorer.exe", [winPath], { detached: true, stdio: "ignore" }).unref();
}

export function updateSessionMeta(dir: string, name: string, patch: SessionMetaPatch): void {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.meta)) return;
  const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
  const next: Meta = { ...m, ...patch };
  if (patch.segments) next.segments = sanitizeSegments(patch.segments);
  writeMeta(dirs.meta, next);
}

// ── dictation corrections (W2a — issues #3+#5) ───────────────────

export interface SessionCorrectionMeta {
  correctedAt: string;
  nEdits: number;
  /** Outcome of the write into the voice corpus (when the session has a datasetId). */
  dataset?: DatasetWriteStatus;
}

/** Atomic write (tmp + rename) — transcript and corpus never truncated. */
function atomicWriteFile(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Saves a session dictation's correction:
 * 1. transcript.json: words edited IN PLACE (start/end/p preserved) and
 *    recomposed text — or plain text swapped when words is empty (fake-hook
 *    dictations / old ones without words);
 * 2. meta.json: correction block (when/how much);
 * 3. voice dataset (fail-soft): if the session has a datasetId and the corpus exists,
 *    writes the validation block there (raw corpus text untouched, tmp+rename).
 *
 * counter target: "ambos" when both targets write, "voicecast" when only
 * the local one (no datasetId or corpus absent).
 */
export function saveCorrection(
  dir: string,
  name: string,
  req: { correctedText: string; edits: CorrectionEdit[] },
): CorrectionResult {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.meta)) return { ok: false, error: "session not found" };
  if (!fs.existsSync(dirs.transcript)) return { ok: false, error: "session without a transcript" };
  let transcript: Transcript;
  try {
    transcript = JSON.parse(fs.readFileSync(dirs.transcript, "utf8")) as Transcript;
  } catch (e) {
    return { ok: false, error: `unreadable transcript: ${String(e)}` };
  }
  const edits = sanitizeEdits(req.edits);

  let corrected: string;
  let nEdits: number;
  if (transcript.words?.length && edits.length) {
    // words are the source: edit in place (timings preserved) and recompose
    const applied = applyEditsToWords(transcript.words, edits);
    corrected = applied.text;
    transcript = { ...transcript, words: applied.words, text: applied.text };
    nEdits = edits.length;
  } else {
    // full rewrite (✍️ text mode, or empty words): the corrected text
    // rules; old words are redistributed over the new text (approximate
    // timings, proportional to the original duration) — the dataset receives
    // validation with n_edits = word diff from the ASR to the corrected text
    corrected = String(req.correctedText ?? "").replace(/\s+/g, " ").trim();
    if (!corrected) return { ok: false, error: "empty correction" };
    const nDiff = diffWordCount(transcript.text ?? "", corrected);
    transcript = { ...transcript, text: corrected, words: redistributeWords(transcript.words ?? [], corrected) };
    nEdits = nDiff;
  }

  try {
    atomicWriteFile(dirs.transcript, JSON.stringify(transcript, null, 2));
  } catch (e) {
    return { ok: false, error: `failed to write transcript: ${String(e)}` };
  }

  // voice dataset: only when the session is linked to a corpus item
  const meta = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
  const dsId = typeof meta.datasetId === "string" ? meta.datasetId : "";
  const dataset = dsId
    ? writeDatasetCorrection(dsId, corrected, edits)
    : "ausente";
  const next: Meta = {
    ...meta,
    correction: { correctedAt: new Date().toISOString(), nEdits, dataset },
  };
  writeMeta(dirs.meta, next);

  const alvo = dataset === "ok" ? "ambos" : "voicecast";
  M_CORRECTIONS?.add(1, { alvo });
  logInfo(
    `correction saved: ${dir}/${name} (${nEdits} edits; dataset=${dataset}${dsId ? ` ${dsId}` : ""})`,
  );
  return { ok: true, alvo, dataset };
}

export function deleteSession(dir: string, name: string): void {
  const dirs = sessionDirs(dir, name);
  if (fs.existsSync(dirs.root)) fs.rmSync(dirs.root, { recursive: true, force: true });
}
