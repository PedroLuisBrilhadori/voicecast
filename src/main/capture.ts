/**
 * Orquestrador de gravação (máquina de estados: idle → recording → processing).
 *
 * Fluxo: picker pede start → barra REC aparece NA HORA (estado "arming") →
 * cria renderer oculto (recorder) que roda getUserMedia(desktop) + mic +
 * MediaRecorder (padrão validado na F0) → ao abrir, startedAt real do
 * recorder.start() vira o relógio da sessão → no stop, blob (base64) volta
 * via IPC → main grava original.fmp4, remuxa
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
import { annotations } from "./annotations";
import { sessionDirs, sessionsRoot } from "./storage";
import { resolveFfmpeg, runFfmpeg, type Ffmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";
import { counter, histogram, withSpan } from "./telemetry";

const M_SESSIONS = counter("voicecast_sessions_total", "sessões finalizadas por modo");
const H_FINALIZE = histogram("voicecast_finalize_seconds", "duração do pipeline de fim de sessão");
const M_STARTS = counter("voicecast_session_starts_total", "inícios de gravação por modo/desfecho");
const H_START = histogram("voicecast_session_start_seconds", "duração do início de sessão por estágio (total/gum-desktop/gum-mic)");
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
  arming: false,
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
  return withSpan("sources.list", { kind }, async () => {
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
  });
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
  return withSpan("session.finalize", { mode: input.mode }, async () => {
  const t0 = Date.now();
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
    void annotations.detach(dirs); // dir existe com meta de erro — anotações ficam
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
  M_SESSIONS?.add(1, { mode });
  H_FINALIZE?.record((Date.now() - t0) / 1000);
  // anotações: persiste log+prints agora que o dir existe (flush antes do done)
  await annotations.detach(dirs);
  emit({ type: "session-done", dir, name, mp4: dirs.mp4 });
  cleanupAfterStop();
  });
}

function cleanupAfterStop(): void {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;
  if (barWin && !barWin.isDestroyed()) barWin.close();
  barWin = null;
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
  setState({ phase: "idle", mode: null, startedAt: null, paused: false, markers: [], arming: false });
}

// ── start/stop/cancel/marker ───────────────────────────────────

export async function selectRegion(displayIndex = 0): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return selectRegionOnDisplay(displayIndex);
}

function startBar(mode: RecordingMode): void {
  const label = mode === "screen" ? "Tela" : mode === "window" ? "Janela" : "Região";
  barWin = createBar(label);
}

/** Resultado do vcRecord no renderer oculto (timings do aquecimento da captura). */
interface VCRecordResult {
  ok: boolean;
  error?: string;
  startedAtReal?: number;
  timings?: { desktopMs: number; micMs: number | null };
}

export async function startRecording(req: StartRecordingRequest): Promise<{ ok: boolean; error?: string }> {
  if (state.phase !== "idle") return { ok: false, error: "já existe gravação em andamento" };
  if (req.mode === "window" && !req.sourceId) return { ok: false, error: "sourceId ausente" };
  if (req.mode === "region" && !req.rect) return { ok: false, error: "retângulo ausente" };

  return withSpan("session.start", { mode: req.mode }, async () => {
    const t0 = Date.now();
    try {
      // startedAt provisório (channel name/session naming); o REAL vem do
      // recorder (startedAtReal, no recorder.start()) — timer/duração/markers
      // têm que casar com o conteúdo do mp4, não com o warm-up da captura.
      setState({ phase: "recording", mode: req.mode, startedAt: Date.now(), paused: false, markers: [], arming: true });
      const startedAt = state.startedAt!;

      // nome da sessão fixado no start (o crash deixa o draft achável)
      const now = new Date();
      const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const name = sessionDirName(now, `${startedAt}:${req.mode}:${Math.random()}`);

      const label =
        req.mode === "region" ? `Região ${req.rect!.width}x${req.rect!.height}` : req.sourceId ?? req.mode;

      // barra IMEDIATA (não espera a captura abrir — antes ela nascia com
      // minutos de "atraso" imaginário porque o timer contava desde o startedAt)
      startBar(req.mode);
      startPreviewTimer();

      const ch = `recorder:blob:${startedAt}`;
      recorderWin = createRecorder(ch);
      await withSpan("recorder.load", {}, async () => {
        await new Promise<void>((res) => {
          if (recorderWin!.webContents.isLoading()) {
            recorderWin!.webContents.once("did-finish-load", () => res());
          } else res();
        });
      });

      const result = (await withSpan("recorder.open", {}, () =>
        recorderWin!.webContents.executeJavaScript(
          `window.vcRecord(${JSON.stringify({
            sourceId: req.sourceId ?? null,
            withMic: req.withMic,
            mode: req.mode,
          })})`,
          false,
        ),
      )) as VCRecordResult | null;
      if (!result?.ok) {
        M_STARTS.add(1, { mode: req.mode, outcome: "erro" });
        cleanupAfterStop();
        setState({ error: result?.error ?? "falha ao iniciar captura" });
        emit({ type: "session-error", message: result?.error ?? "falha ao iniciar captura" });
        return { ok: false, error: result?.error };
      }

      // armado: relógio da sessão passa a ser o do recorder.start()
      const armadoEm = result.startedAtReal ?? startedAt;
      setState({ startedAt: armadoEm, arming: false });
      const tm = result.timings;
      logInfo(
        `start ok: total=${((Date.now() - t0) / 1000).toFixed(2)}s (desktop=${tm?.desktopMs ?? "?"}ms mic=${tm?.micMs ?? "-"}ms)`,
      );
      H_START.record((Date.now() - t0) / 1000, { mode: req.mode, stage: "total" });
      if (tm) {
        H_START.record(tm.desktopMs / 1000, { mode: req.mode, stage: "gum-desktop" });
        if (tm.micMs != null) H_START.record(tm.micMs / 1000, { mode: req.mode, stage: "gum-mic" });
      }
      M_STARTS.add(1, { mode: req.mode, outcome: "ok" });

      // pipeline no fim: blob → main processa (canal chega ao recorder via query ?ch=)
      ipcMain.once(ch, (_e, payload: { b64: string; ext: string }) => {
        void finalizeSession({ dir: dayDir, name, b64: payload.b64, startedAt: armadoEm, mode: req.mode, sourceLabel: label, rect: req.rect });
      });

      registerMarkerShortcut();

      // AN.1: overlay de anotações junto com a barra (WYSIWYG — D2); o dir só
      // existe no stop → log/prints em buffer até o detach. Painel standalone
      // aberto antes? É adotado (traços pré-REC entram na sessão).
      annotations.beginSession("session", armadoEm);

      return { ok: true };
    } catch (e) {
      M_STARTS.add(1, { mode: req.mode, outcome: "erro" });
      cleanupAfterStop();
      return { ok: false, error: String(e) };
    }
  });
}

/** Preview periódico p/ a barra (thumb leve da tela ativa) — roda desde o arming. */
function startPreviewTimer(): void {
  previewTimer = setInterval(async () => {
    try {
      const srcs = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 320, height: 180 },
      });
      if (srcs[0]) emit({ type: "preview", dataUrl: srcs[0].thumbnail.toDataURL() });
    } catch {}
  }, 2000);
}

export async function stopRecording(): Promise<{ ok: boolean; error?: string }> {
  if (state.phase !== "recording" || !recorderWin) return { ok: false, error: "nada gravando" };
  // captura ainda abrindo: não há o que parar — cancela limpo (a barra trava
  // o botão, mas o toggle do Ctrl+Shift+F9 chega aqui)
  if (state.arming) return cancelRecording();
  logInfo("stop pedido — aguardando blob do recorder…");
  setState({ phase: "processing" });
  await recorderWin.webContents.executeJavaScript("window.vcStop()", true).catch((e) => {
    logError("vcStop falhou:", String(e));
  });
  // o blob tem que chegar em 20s — sem ele o finalizeSession (e o detach das
  // anotações dentro dele) nunca roda e a janela de pintura fica na tela
  setTimeout(() => {
    if (state.phase !== "processing") return;
    logError("stop: blob do recorder não chegou em 20s — descarto a sessão");
    void annotations.detach();
    cleanupAfterStop();
    emit({ type: "session-error", message: "gravador não entregou o vídeo — sessão descartada" });
  }, 20_000).unref?.();
  return { ok: true };
}

export async function cancelRecording(): Promise<{ ok: boolean }> {
  if (recorderWin && !recorderWin.isDestroyed()) {
    await recorderWin.webContents.executeJavaScript("window.vcCancel()", true).catch(() => {});
  }
  void annotations.detach(); // cancelado: sessão não será salva, buffer descartado
  cleanupAfterStop();
  return { ok: true };
}

export async function addMarker(): Promise<{ ok: boolean }> {
  if (state.phase !== "recording" || state.arming || !state.startedAt) return { ok: false };
  state.markers.push(Date.now());
  emit({ type: "state", state: { ...state } });
  // D6: marker vira âncora de contexto — print com as marcações queimadas
  void annotations.marker(state.markers.length);
  return { ok: true };
}

export function setPaused(p: boolean): void {
  if (state.arming) return; // sem MediaRecorder ainda — estado ia dessincronizar
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
