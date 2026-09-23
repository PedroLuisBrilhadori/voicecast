/**
 * Pós-processamento de sessão: transcrição automática, clipes, frames e
 * geração do contexto para agentes ("Copiar para o ZCode").
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
import type { ClipInfo, SessionMetaPatch, SessionSegment } from "../shared/ipc";
import { clipFileBase, cutFileBase, sanitizeSegments, wordsInRange } from "../shared/segments";
import { counter, histogram, withSpan } from "./telemetry";

// voicecast_sessions_total é do capture.ts (que emite); duplicar aqui criava
// confusão — com o core lazy cairia no mesmo instrumento, mas fica num lugar só
const M_TRANSCRIBE = counter("voicecast_transcriptions_total", "transcrições por status");
const H_TRANSCRIBE = histogram("voicecast_transcribe_seconds", "duração da transcrição ASR");
const M_CUT = counter("voicecast_cuts_total", "cortes combinados por desfecho");
const H_CUT = histogram("voicecast_cut_seconds", "duração do corte combinado (exportCut)");

// ── tipos de biblioteca ────────────────────────────────────────

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
  thumb: string | null; // caminho Windows do thumb (ou null)
  markers: number[];
  /** Primeiras palavras da transcrição (subtítulo do card). */
  preview: string | null;
}

/** Julgamento Jev gravado no meta.json (Etapa 2 do PLANO-JEV-CU). */
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
  /** Trechos nomeados do editor (fase B) — sempre sanitizados antes de gravar. */
  segments?: SessionSegment[];
  /** Ditado: primeira frase da transcrição (título automático). */
  textPreview?: string;
  /** Julgamento Jev (fail-soft: ausente quando off/sem key/erro). */
  jev?: JevMeta;
}

// ── biblioteca ─────────────────────────────────────────────────

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

/** Busca full-text simples: título + texto da transcrição + tags. */
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

/** Persiste um ditado como sessão de áudio na biblioteca (mesmo layout). */
export function saveDictationSession(
  startedAt: number,
  ext: string,
  audioB64: string,
  transcript: Transcript,
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
  fs.writeFileSync(dirs.transcript, JSON.stringify(transcript, null, 2));
  const preview = transcript.text.replace(/\s+/g, " ").trim().slice(0, 60);
  writeMeta(dirs.meta, {
    status: "finalizada",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationS: +((Date.now() - startedAt) / 1000).toFixed(1),
    mode: "ditado",
    sourceLabel: "mic",
    title: preview || "Ditado vazio",
    textPreview: preview,
    transcriptStatus: "done",
    sizeBytes: fs.statSync(dirs.audio).size,
    ...(jev
      ? { jev: { model: jev.model, judgedAt: new Date().toISOString(), rota: jev.rota, conf: jev.confidence } }
      : {}),
  });
  logInfo(`ditado salvo na biblioteca: ${dayDir}/${name} "${preview}"`);
  return { dir: dayDir, name };
}

// ── transcrição (chamada no fim da sessão e manual) ────────────

export async function transcribeAndStore(dir: string, name: string): Promise<boolean> {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return false;
  const patch = (p: Partial<Meta>) => {
    const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
    writeMeta(dirs.meta, { ...m, ...p });
  };
  patch({ transcriptStatus: "pending" });
  // espera o host do ASR abrir a porta (spawn no boot do app leva segundos —
  // sem isso, --transcribe na cold start perde a corrida e marca sem-asr)
  const health = await asrHealth({ waitMs: 30_000 });
  if (!health.ok) {
    logError("ASR fora do ar — transcrição ficará pendente (retranscreva depois)");
    patch({ transcriptStatus: "sem-asr" });
    M_TRANSCRIBE?.add(1, { status: "sem-asr" });
    return false;
  }
  const t0 = Date.now();
  try {
    const t = await transcribeSession(dirs.mp4);
    fs.writeFileSync(dirs.transcript, JSON.stringify(t, null, 2));
    patch({ transcriptStatus: "done" });
    H_TRANSCRIBE?.record((Date.now() - t0) / 1000, { kind: "sessao" });
    M_TRANSCRIBE?.add(1, { status: "ok" });
    logInfo(`transcrição pronta: ${dir}/${name} (${t.words.length} palavras)`);

    // Etapa 2: julgamento Jev da sessão (fail-soft — julgamento é melhoria,
    // não dependência; falha aqui não afeta a transcrição pronta)
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
          `jev: ${dir}/${name} → rota ${j.rota ?? "?"} · relevância ${j.relevancia?.toFixed(1) ?? "?"}/3 · ${j.latenciaMs.toFixed(0)}ms`,
        );
      }
    } catch (e) {
      logError("jev: julgamento da sessão falhou (sessão intacta):", e);
    }
    return true;
  } catch (e) {
    logError("transcrição falhou:", e);
    patch({ transcriptStatus: "erro" });
    M_TRANSCRIBE?.add(1, { status: "erro" });
    return false;
  }
}

function writeMeta(metaPath: string, meta: unknown): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ── clipes e frames ────────────────────────────────────────────

export async function createClip(
  dir: string,
  name: string,
  inS: number,
  outS: number,
  label?: string,
): Promise<{ file: string; bytes: number } | { error: string }> {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return { error: "mp4 ausente" };
  fs.mkdirSync(dirs.clips, { recursive: true });
  const dest = path.join(dirs.clips, `${clipFileBase(label ?? "", inS, outS)}.mp4`);
  try {
    const ff = await resolveFfmpeg();
    // corte exato: re-encode leve (corta em qualquer frame, não só keyframe)
    await runFfmpeg(ff, [
      "-y", "-ss", String(inS), "-i", dirs.mp4, "-to", String(Math.max(0.1, outS - inS)),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "96k",
      dest,
    ]);
    return { file: dest, bytes: fs.statSync(dest).size };
  } catch (e) {
    logError("clipe falhou:", e);
    return { error: String(e) };
  }
}

/** Clipes .mp4 existentes em clips/ — a lista do editor (fase A gravava, não listava). */
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
 * Corte combinado (fase B): recorta cada segmento (mesmo encode do createClip
 * — params idênticos são pré-requisito do concat) e junta num mp4 único em
 * clips/<label>-<N>seg.mp4. Re-export sobrescreve (nome determinístico).
 */
export async function exportCut(
  dir: string,
  name: string,
  segments: SessionSegment[],
  label = "corte",
): Promise<{ file: string; bytes: number } | { error: string }> {
  const segs = sanitizeSegments(segments);
  if (!segs.length) return { error: "sem segmentos válidos" };
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return { error: "mp4 ausente" };
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
    // concat demuxer: paths escapados p/ aspas simples (sintaxe do próprio ffmpeg)
    const listFile = path.join(tmp, "list.txt");
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const dest = path.join(dirs.clips, `${cutFileBase(label, segs.length)}.mp4`);
    await runFfmpeg(ff, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", dest]);
    H_CUT?.record((Date.now() - t0) / 1000, { segments: String(segs.length) });
    M_CUT?.add(1, { status: "ok" });
    logInfo(`corte combinado pronto: ${dir}/${name} (${segs.length} segmentos)`);
    return { file: dest, bytes: fs.statSync(dest).size };
  } catch (e) {
    logError("corte falhou:", e);
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
  if (!fs.existsSync(dirs.mp4)) return { error: "mp4 ausente" };
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

// ── contexto para agentes ──────────────────────────────────────

export interface ContextInput {
  dir: string;
  name: string;
  /** trecho selecionado (opcional): filtra transcrição e cita o clipe */
  range?: { inS: number; outS: number } | null;
  includeFullTranscript?: boolean;
}

function fmtTs(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export async function buildContext(
  input: ContextInput,
): Promise<{ markdown: string } | { error: string }> {
  const detail = getSessionDetail(input.dir, input.name);
  if (!detail) return { error: "sessão não encontrada" };
  const dirs = sessionDirs(input.dir, input.name);
  const { meta, transcript } = detail;
  const title = meta.title || `Sessão ${input.name}`;
  const dur = meta.durationS ? `${fmtTs(meta.durationS)}` : "?";

  const lines: string[] = [];
  lines.push(
    `### voicecast ${input.dir} ${input.name.slice(0, 4)} (${dur}) — ${title}${meta.mode === "ditado" ? " · ditado" : ""}`,
  );

  // mídia principal
  if (fs.existsSync(dirs.mp4)) {
    lines.push(`Vídeo: ${wslPathQuoted(dirs.mp4)}`);
  } else if (fs.existsSync(dirs.audio)) {
    lines.push(`Áudio: ${wslPathQuoted(dirs.audio)}`);
  }

  // trecho transcrito
  if (transcript) {
    const words = transcript.words ?? [];
    const inS = input.range?.inS ?? 0;
    const outS = input.range?.outS ?? Infinity;
    const sel = wordsInRange(words, inS, outS);
    const slice = sel.length ? sel : input.range ? [] : words;
    if (slice.length) {
      const text = slice.map((w) => w.w).join(" ").replace(/\s+/g, " ").trim();
      const from = input.range ? ` (${fmtTs(inS)}–${fmtTs(outS)})` : " (completa)";
      lines.push(`Fala${from}: "${text}"`);
    }
  } else if (meta.transcriptStatus === "pending") {
    lines.push("Fala: (transcrição em andamento)");
  }

  // trechos nomeados (editor fase B): fala de cada segmento + clipe quando existe
  const segs = meta.segments ?? [];
  if (segs.length) {
    lines.push(`Trechos (${segs.length}):`);
    for (const [i, s] of segs.entries()) {
      const slice = transcript ? wordsInRange(transcript.words ?? [], s.inS, s.outS) : [];
      const text = slice.length
        ? slice.map((w) => w.w).join(" ").replace(/\s+/g, " ").trim()
        : "(sem fala no trecho)";
      lines.push(`${i + 1}. ${s.label} (${fmtTs(s.inS)}–${fmtTs(s.outS)}): ${text ? `"${text}"` : text}`);
      const clip = path.join(dirs.clips, `${clipFileBase(s.label, s.inS, s.outS)}.mp4`);
      if (fs.existsSync(clip)) lines.push(`   Clipe: ${wslPathQuoted(clip)}`);
    }
    const cut = path.join(dirs.clips, `${cutFileBase("corte", segs.length)}.mp4`);
    if (fs.existsSync(cut)) {
      lines.push(`Corte combinado (${segs.length} trechos): ${wslPathQuoted(cut)}`);
    }
  }

  // julgamento Jev (Etapa 2) — triagem pronta para o agente consumir
  if (meta.jev) {
    const partes: string[] = [];
    if (meta.jev.rota) partes.push(`rota ${meta.jev.rota}${meta.jev.conf != null ? ` (conf ${meta.jev.conf.toFixed(2)})` : ""}`);
    if (meta.jev.relevancia != null) partes.push(`relevância ${meta.jev.relevancia.toFixed(1)}/3`);
    if (meta.jev.pedido != null) partes.push(`pedido-de-ação ${meta.jev.pedido.toFixed(2)}`);
    if (meta.jev.risco != null) partes.push(`risco ${meta.jev.risco.toFixed(2)}`);
    if (partes.length) lines.push(`Julgamento (Jev ${meta.jev.model}): ${partes.join(" · ")}`);
  }

  // clipes e frames
  const clips = fs.existsSync(dirs.clips)
    ? fs.readdirSync(dirs.clips).filter((f) => f.endsWith(".mp4"))
    : [];
  if (clips.length) {
    lines.push(
      `Clipes: ${clips.map((c) => wslPathQuoted(path.join(dirs.clips, c))).join(" · ")}`,
    );
  }
  const frames = fs.existsSync(dirs.frames)
    ? fs.readdirSync(dirs.frames).filter((f) => f.endsWith(".png"))
    : [];
  if (frames.length) {
    lines.push(
      `Prints: ${frames.map((f) => wslPathQuoted(path.join(dirs.frames, f))).join(" · ")}`,
    );
  }
  lines.push(`Pasta da sessão: ${wslPathQuoted(dirs.root)}`);
  lines.push("");
  lines.push(
    "Use os prints (PNG, leia como imagem) e o vídeo (MP4, leia como vídeo) para entender o contexto visual; os paths acima são WSL.",
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

export function deleteSession(dir: string, name: string): void {
  const dirs = sessionDirs(dir, name);
  if (fs.existsSync(dirs.root)) fs.rmSync(dirs.root, { recursive: true, force: true });
}
