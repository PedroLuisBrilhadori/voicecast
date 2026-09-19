/**
 * Orquestrador de gravação (máquina de estados: idle → recording → processing).
 *
 * Fluxo: picker pede start → cria renderer oculto (recorder) que roda
 * getUserMedia(desktop) + mic + MediaRecorder (padrão validado na F0) →
 * no stop, blob (base64) volta via IPC → main grava original.fmp4, remuxa
 * (-c copy +faststart) para session.mp4, extrai thumb e escreve meta.json
 * (draft ANTES, finalizada depois — crash-safe, padrão voice-11).
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  IPC,
  type CaptureEvent,
  type RecordingMode,
  type RecordingState,
  type SourceInfo,
  type StartRecordingRequest,
} from "../shared/ipc";
import { sessionDirName } from "../shared/paths";
import { sessionDirs, sessionsRoot } from "./storage";
import { resolveFfmpeg, runFfmpeg, type Ffmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";
import { createBar, createRecorder, selectRegionOnDisplay } from "./windows";

type Listener = (e: CaptureEvent) => void;
const listeners = new Set<Listener>();

function emit(e: CaptureEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {}
  }
}

let recorderWin: BrowserWindow | null = null;
let barWin: BrowserWindow | null = null;
let markerShortcutRegistered = false;
let previewTimer: NodeJS.Timeout | null = null;

const state: RecordingState = {
  phase: "idle",
  mode: null,
  startedAt: null,
  paused: false,
  markers: [],
};

function setState(patch: Partial<RecordingState>): void {
  Object.assign(state, patch);
  emit({ type: "state", state: { ...state } });
}

export function getState(): RecordingState {
  return { ...state };
}

export function subscribeEvents(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── fontes ─────────────────────────────────────────────────────

export async function listSources(kind: "screen" | "window"): Promise<SourceInfo[]> {
  const thumbW = kind === "screen" ? 480 : 320;
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: { width: thumbW, height: Math.round((thumbW * 9) / 16) },
    fetchWindowIcons: false,
  });
  return sources
    .filter((s) => (kind === "window" ? s.name && !/^voicecast/i.test(s.name) : true))
    .map((s) => ({
      id: s.id,
      kind,
      name: s.name || (kind === "screen" ? "Tela" : "(sem título)"),
      thumb: s.thumbnail.toDataURL(),
    }));
}

// ── pipeline de finalização ────────────────────────────────────

interface FinishInput {
  dir: string;
  name: string;
  b64: string;
  startedAt: number;
  mode: RecordingMode;
  sourceLabel: string;
  rect?: { x: number; y: number; width: number; height: number };
}

function writeMeta(metaPath: string, meta: unknown): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

async function finalizeSession(input: FinishInput): Promise<void> {
  const { dir, name, b64, startedAt, mode, sourceLabel, rect } = input;
  logInfo(`finishRecording: ${name} blob=${(b64.length / 1_048_576).toFixed(1)}MB(b64)`);
  const dirs = sessionDirs(dir, name);
  fs.mkdirSync(dirs.root, { recursive: true });
  fs.mkdirSync(dirs.thumbs, { recursive: true });

  // draft ANTES de processar (crash-safe)
  writeMeta(dirs.meta, {
    status: "draft",
    startedAt: new Date(startedAt).toISOString(),
    mode,
    sourceLabel,
    rect: rect ?? null,
  });
  fs.writeFileSync(dirs.video, Buffer.from(b64, "base64"));

  try {
    const ff = await resolveFfmpeg();
    // fMP4 do MediaRecorder vem sem duração → remux -c copy +faststart é obrigatório
    await runFfmpeg(ff, ["-y", "-i", dirs.video, "-c", "copy", "-movflags", "+faststart", dirs.mp4]);
    logInfo(`remux ok: ${dirs.mp4}`);
    await runFfmpeg(
      ff,
      ["-y", "-ss", "1", "-i", dirs.mp4, "-frames:v", "1", "-vf", "scale=480:-2", path.join(dirs.thumbs, "session.png")],
    );
  } catch (e) {
    logError("remux falhou:", String(e));
    writeMeta(dirs.meta, {
      status: "erro-remux",
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      mode,
      sourceLabel,
      error: String(e),
    });
    emit({ type: "session-error", message: `remux falhou: ${String(e)}` });
    cleanupAfterStop();
    return;
  }

  const sizeBytes = fs.existsSync(dirs.mp4) ? fs.statSync(dirs.mp4).size : 0;
  writeMeta(dirs.meta, {
    status: "finalizada",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationS: +((Date.now() - startedAt) / 1000).toFixed(1),
    mode,
    sourceLabel,
    rect: rect ?? null,
    markers: state.markers.map((ms) => +((ms - startedAt) / 1000).toFixed(2)),
    sizeBytes,
  });

  logInfo(`sessão finalizada: ${dir}/${name} (${(sizeBytes / 1_048_576).toFixed(1)}MB)`);
  emit({ type: "session-done", dir, name, mp4: dirs.mp4 });
  cleanupAfterStop();
}

function cleanupAfterStop(): void {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;
  if (barWin && !barWin.isDestroyed()) barWin.close();
  barWin = null;
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
  setState({ phase: "idle", mode: null, startedAt: null, paused: false, markers: [] });
}

// ── start/stop/cancel/marker ───────────────────────────────────

export async function selectRegion(displayIndex = 0): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return selectRegionOnDisplay(displayIndex);
}

function startBar(mode: RecordingMode): void {
  const label = mode === "screen" ? "Tela" : mode === "window" ? "Janela" : "Região";
  barWin = createBar(label);
}

export async function startRecording(req: StartRecordingRequest): Promise<{ ok: boolean; error?: string }> {
  if (state.phase !== "idle") return { ok: false, error: "já existe gravação em andamento" };
  if (req.mode === "window" && !req.sourceId) return { ok: false, error: "sourceId ausente" };
  if (req.mode === "region" && !req.rect) return { ok: false, error: "retângulo ausente" };

  try {
    setState({ phase: "recording", mode: req.mode, startedAt: Date.now(), paused: false, markers: [] });
    const startedAt = state.startedAt!;

    // nome da sessão fixado no start (o crash deixa o draft achável)
    const now = new Date();
    const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const name = sessionDirName(now, `${startedAt}:${req.mode}:${Math.random()}`);

    const label =
      req.mode === "region" ? `Região ${req.rect!.width}x${req.rect!.height}` : req.sourceId ?? req.mode;

    const ch = `recorder:blob:${startedAt}`;
    recorderWin = createRecorder(ch);
    await new Promise<void>((res) => {
      if (recorderWin!.webContents.isLoading()) {
        recorderWin!.webContents.once("did-finish-load", () => res());
      } else res();
    });

    const result = await recorderWin.webContents.executeJavaScript(
      `window.vcRecord(${JSON.stringify({
        sourceId: req.sourceId ?? null,
        withMic: req.withMic,
        mode: req.mode,
      })})`,
      false,
    );
    if (!result?.ok) {
      cleanupAfterStop();
      setState({ error: result?.error ?? "falha ao iniciar captura" });
      emit({ type: "session-error", message: result?.error ?? "falha ao iniciar captura" });
      return { ok: false, error: result?.error };
    }

    // pipeline no fim: blob → main processa (canal chega ao recorder via query ?ch=)
    ipcMain.once(ch, (_e, payload: { b64: string; ext: string }) => {
      void finalizeSession({ dir: dayDir, name, b64: payload.b64, startedAt, mode: req.mode, sourceLabel: label, rect: req.rect });
    });

    startBar(req.mode);
    registerMarkerShortcut();

    // preview periódico p/ a barra (thumb leve da tela ativa)
    previewTimer = setInterval(async () => {
      try {
        const srcs = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 320, height: 180 },
        });
        if (srcs[0]) emit({ type: "preview", dataUrl: srcs[0].thumbnail.toDataURL() });
      } catch {}
    }, 2000);

    return { ok: true };
  } catch (e) {
    cleanupAfterStop();
    return { ok: false, error: String(e) };
  }
}

export async function stopRecording(): Promise<{ ok: boolean; error?: string }> {
  if (state.phase !== "recording" || !recorderWin) return { ok: false, error: "nada gravando" };
  logInfo("stop pedido — aguardando blob do recorder…");
  setState({ phase: "processing" });
  await recorderWin.webContents.executeJavaScript("window.vcStop()", true).catch((e) => {
    logError("vcStop falhou:", String(e));
  });
  return { ok: true };
}

export async function cancelRecording(): Promise<{ ok: boolean }> {
  if (recorderWin && !recorderWin.isDestroyed()) {
    await recorderWin.webContents.executeJavaScript("window.vcCancel()", true).catch(() => {});
  }
  cleanupAfterStop();
  return { ok: true };
}

export async function addMarker(): Promise<{ ok: boolean }> {
  if (state.phase !== "recording" || !state.startedAt) return { ok: false };
  state.markers.push(Date.now());
  emit({ type: "state", state: { ...state } });
  return { ok: true };
}

export function setPaused(p: boolean): void {
  if (recorderWin && !recorderWin.isDestroyed()) {
    void recorderWin.webContents.executeJavaScript(`window.vcPause(${p})`, true).catch(() => {});
    setState({ paused: p });
  }
}

// Ctrl+M só existe enquanto grava (não rouba a tecla no dia a dia)
function registerMarkerShortcut(): void {
  if (markerShortcutRegistered) return;
  const { globalShortcut } = require("electron") as typeof import("electron");
  globalShortcut.register("Control+M", () => void addMarker());
  markerShortcutRegistered = true;
  const unreg = () => {
    globalShortcut.unregister("Control+M");
    markerShortcutRegistered = false;
  };
  const iv = setInterval(() => {
    if (state.phase !== "recording") {
      unreg();
      clearInterval(iv);
    }
  }, 1000);
}

/** Retenção: apaga sessões mais velhas que N dias no boot (default 30). */
export function applyRetention(days = Number(process.env.VOICECAST_RETENTION_DAYS ?? "30")): void {
  const root = sessionsRoot();
  if (!fs.existsSync(root) || !Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 86_400_000;
  for (const day of fs.readdirSync(root)) {
    const dayPath = path.join(root, day);
    try {
      if (fs.statSync(dayPath).mtimeMs < cutoff) fs.rmSync(dayPath, { recursive: true, force: true });
    } catch {}
  }
}

export { screen };
