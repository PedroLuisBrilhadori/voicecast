/**
 * Pós-processamento de sessão: transcrição automática, clipes, frames e
 * geração do contexto para agentes ("Copiar para o ZCode").
 */
import { clipboard } from "electron";
import fs from "node:fs";
import path from "node:path";
import { asrHealth, transcribeSession, type Transcript } from "./asr";
import { resolveFfmpeg, runFfmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";
import { sessionDirs, sessionsRoot } from "./storage";
import { wslPathQuoted, winPathToWsl } from "../shared/paths";

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
          hasTranscript: fs.existsSync(dirs.transcript),
          transcriptStatus: m.transcriptStatus ?? null,
          thumb: fs.existsSync(path.join(dirs.thumbs, "session.png"))
            ? path.join(dirs.thumbs, "session.png")
            : null,
          markers: m.markers ?? [],
        });
      } catch {}
    }
  }
  out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return out;
}

export function getSessionDetail(
  dir: string,
  name: string,
): { meta: Meta; transcript: Transcript | null; mp4: string } | null {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.meta)) return null;
  const meta = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
  const transcript = fs.existsSync(dirs.transcript)
    ? (JSON.parse(fs.readFileSync(dirs.transcript, "utf8")) as Transcript)
    : null;
  return { meta, transcript, mp4: dirs.mp4 };
}

const safeNamePart = (s: string) => s.replace(/[^\w.-]+/g, "-").slice(0, 60);

// ── transcrição (chamada no fim da sessão e manual) ────────────

export async function transcribeAndStore(dir: string, name: string): Promise<boolean> {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.mp4)) return false;
  const patch = (p: Partial<Meta>) => {
    const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
    writeMeta(dirs.meta, { ...m, ...p });
  };
  patch({ transcriptStatus: "pending" });
  const health = await asrHealth();
  if (!health.ok) {
    logError("ASR fora do ar — transcrição ficará pendente (retranscreva depois)");
    patch({ transcriptStatus: "sem-asr" });
    return false;
  }
  try {
    const t = await transcribeSession(dirs.mp4);
    fs.writeFileSync(dirs.transcript, JSON.stringify(t, null, 2));
    patch({ transcriptStatus: "done" });
    logInfo(`transcrição pronta: ${dir}/${name} (${t.words.length} palavras)`);
    return true;
  } catch (e) {
    logError("transcrição falhou:", e);
    patch({ transcriptStatus: "erro" });
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
  const base = `${safeNamePart(label || "trecho")}-${Math.round(inS)}s-${Math.round(outS)}s`;
  const dest = path.join(dirs.clips, `${base}.mp4`);
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
  lines.push(`### voicecast ${input.dir} ${input.name.slice(0, 4)} (${dur}) — ${title}`);

  // vídeo principal
  lines.push(`Vídeo: ${wslPathQuoted(dirs.mp4)}`);

  // trecho transcrito
  if (transcript) {
    const words = transcript.words ?? [];
    const inS = input.range?.inS ?? 0;
    const outS = input.range?.outS ?? Infinity;
    const sel = words.filter((w) => w.end > inS && w.start < outS);
    const slice = sel.length ? sel : input.range ? [] : words;
    if (slice.length) {
      const text = slice.map((w) => w.w).join(" ").replace(/\s+/g, " ").trim();
      const from = input.range ? ` (${fmtTs(inS)}–${fmtTs(outS)})` : " (completa)";
      lines.push(`Fala${from}: "${text}"`);
    }
  } else if (meta.transcriptStatus === "pending") {
    lines.push("Fala: (transcrição em andamento)");
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

export function updateSessionMeta(
  dir: string,
  name: string,
  patch: { title?: string; tags?: string[] },
): void {
  const dirs = sessionDirs(dir, name);
  if (!fs.existsSync(dirs.meta)) return;
  const m = JSON.parse(fs.readFileSync(dirs.meta, "utf8")) as Meta;
  writeMeta(dirs.meta, { ...m, ...patch });
}

export function deleteSession(dir: string, name: string): void {
  const dirs = sessionDirs(dir, name);
  if (fs.existsSync(dirs.root)) fs.rmSync(dirs.root, { recursive: true, force: true });
}
