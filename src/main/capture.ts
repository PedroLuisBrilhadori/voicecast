/**
 * Recording orchestrator (state machine: idle → recording → processing).
 *
 * Flow: picker asks for start → REC bar appears RIGHT AWAY ("arming" state) →
 * creates hidden renderer (recorder) running getUserMedia(desktop) + mic +
 * MediaRecorder (pattern validated in F0) → once open, the real startedAt of
 * recorder.start() becomes the session clock → on stop, blob (base64) comes back
 * via IPC → main writes original.fmp4, remuxes
 * (-c copy +faststart) to session.mp4, extracts thumb and writes meta.json
 * (draft FIRST, finalized later — crash-safe, voice-11 pattern).
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  IPC,
  type CaptureEvent,
  type RecordingMode,
  type RecordingState,
  type RegionSelection,
  type SourceInfo,
  type StartRecordingRequest,
} from "../shared/ipc";
import { sessionDirName } from "../shared/paths";
import { annotations } from "./annotations";
import { sessionDirs, sessionsRoot } from "./storage";
import { resolveFfmpeg, runFfmpeg, type Ffmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";
import { counter, histogram, withSpan } from "./telemetry";

const M_SESSIONS = counter("voicecast_sessions_total", "finalized sessions by mode");
const H_FINALIZE = histogram("voicecast_finalize_seconds", "session finalization pipeline duration");
const M_STARTS = counter("voicecast_session_starts_total", "recording starts by mode/outcome");
const H_START = histogram("voicecast_session_start_seconds", "session start duration by stage (total/gum-desktop/gum-mic)");
import { createBar, createRecorder, selectRegionOnDisplays } from "./windows";

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

// ── sources ─────────────────────────────────────────────────────

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
        name: s.name || (kind === "screen" ? "Screen" : "(untitled)"),
        thumb: s.thumbnail.toDataURL(),
      }));
  });
}

// ── finalization pipeline ────────────────────────────────────

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

  // draft BEFORE processing (crash-safe)
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
    if (mode === "region" && rect) {
      // region: records the whole display and CROPS on remux (light re-encode,
      // even dims — h264 requirement). rect coordinates are physical px
      // of the display; the getDisplayMedia mp4 is physical at the same scale.
      const w = rect.width - (rect.width % 2);
      const h = rect.height - (rect.height % 2);
      await runFfmpeg(ff, [
        "-y", "-i", dirs.video,
        "-vf", `crop=${w}:${h}:${rect.x}:${rect.y}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        dirs.mp4,
      ]);
    } else {
      // MediaRecorder fMP4 comes without duration → remux -c copy +faststart is mandatory
      await runFfmpeg(ff, ["-y", "-i", dirs.video, "-c", "copy", "-movflags", "+faststart", dirs.mp4]);
    }
    logInfo(`remux ok: ${dirs.mp4}`);
    await runFfmpeg(
      ff,
      ["-y", "-ss", "1", "-i", dirs.mp4, "-frames:v", "1", "-vf", "scale=480:-2", path.join(dirs.thumbs, "session.png")],
    );
  } catch (e) {
    logError("remux failed:", String(e));
    writeMeta(dirs.meta, {
      status: "erro-remux",
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      mode,
      sourceLabel,
      error: String(e),
    });
    emit({ type: "session-error", message: `remux failed: ${String(e)}` });
    void annotations.detach(dirs); // dir exists with error meta — annotations stay
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

  logInfo(`session finalized: ${dir}/${name} (${(sizeBytes / 1_048_576).toFixed(1)}MB)`);
  M_SESSIONS?.add(1, { mode });
  H_FINALIZE?.record((Date.now() - t0) / 1000);
  // annotations: persists log+shots now that the dir exists (flush before done)
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

export function selectRegion(): Promise<RegionSelection | null> {
  return selectRegionOnDisplays();
}

function startBar(mode: RecordingMode): void {
  const label = mode === "screen" ? "Screen" : mode === "window" ? "Window" : "Region";
  barWin = createBar(label);
}

/** vcRecord result in the hidden renderer (capture warm-up timings). */
interface VCRecordResult {
  ok: boolean;
  error?: string;
  startedAtReal?: number;
  timings?: { desktopMs: number; micMs: number | null };
}

export async function startRecording(req: StartRecordingRequest): Promise<{ ok: boolean; error?: string }> {
  if (state.phase !== "idle") return { ok: false, error: "a recording is already in progress" };
  if (req.mode === "window" && !req.sourceId) return { ok: false, error: "missing sourceId" };
  if (req.mode === "region" && !req.rect) return { ok: false, error: "missing rect" };

  // region: resolve the sourceId of the DISPLAY where the rect is (desktopCapturer
  // order matches screen.getAllDisplays) — without this the recorder
  // recorded the wrong screen or wouldn't even start
  let regionSourceId: string | null = req.sourceId ?? null;
  if (req.mode === "region") {
    const screens = await listSources("screen");
    const idx = Math.max(0, Math.min(req.displayIndex ?? 0, screens.length - 1));
    regionSourceId = screens[idx]?.id ?? null;
    if (!regionSourceId) return { ok: false, error: "no screen available for the region" };
  }

  return withSpan("session.start", { mode: req.mode }, async () => {
    const t0 = Date.now();
    try {
      // provisional startedAt (channel name/session naming); the REAL one comes from
      // the recorder (startedAtReal, at recorder.start()) — timer/duration/markers
      // have to match the mp4 content, not the capture warm-up.
      setState({ phase: "recording", mode: req.mode, startedAt: Date.now(), paused: false, markers: [], arming: true });
      const startedAt = state.startedAt!;

      // session name fixed at start (a crash leaves the draft findable)
      const now = new Date();
      const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const name = sessionDirName(now, `${startedAt}:${req.mode}:${Math.random()}`);

      const label =
        req.mode === "region" ? `Region ${req.rect!.width}x${req.rect!.height}` : req.sourceId ?? req.mode;

      // IMMEDIATE bar (doesn't wait for the capture to open — before, it was born with
      // minutes of imaginary "delay" because the timer counted from startedAt)
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
            sourceId: req.mode === "region" ? regionSourceId : req.sourceId ?? null,
            withMic: req.withMic,
            mode: req.mode,
          })})`,
          false,
        ),
      )) as VCRecordResult | null;
      if (!result?.ok) {
        M_STARTS.add(1, { mode: req.mode, outcome: "erro" });
        cleanupAfterStop();
        setState({ error: result?.error ?? "failed to start capture" });
        emit({ type: "session-error", message: result?.error ?? "failed to start capture" });
        return { ok: false, error: result?.error };
      }

      // armed: the session clock becomes recorder.start()'s
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

      // pipeline at the end: blob → main processes (channel reaches the recorder via query ?ch=)
      ipcMain.once(ch, (_e, payload: { b64: string; ext: string }) => {
        void finalizeSession({ dir: dayDir, name, b64: payload.b64, startedAt: armadoEm, mode: req.mode, sourceLabel: label, rect: req.rect });
      });

      registerMarkerShortcut();

      // AN.1: annotations overlay comes up with the bar (WYSIWYG — D2); the dir only
      // exists at stop → log/shots buffered until detach. Standalone panel
      // opened earlier? It's adopted (pre-REC strokes join the session).
      annotations.beginSession("session", armadoEm);

      return { ok: true };
    } catch (e) {
      M_STARTS.add(1, { mode: req.mode, outcome: "erro" });
      cleanupAfterStop();
      return { ok: false, error: String(e) };
    }
  });
}

/** Periodic preview for the bar (light thumb of the active screen) — runs since arming. */
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
  if (state.phase !== "recording" || !recorderWin) return { ok: false, error: "nothing recording" };
  // capture still opening: nothing to stop — cancels cleanly (the bar locks
  // the button, but the Ctrl+Shift+F9 toggle reaches here)
  if (state.arming) return cancelRecording();
  logInfo("stop requested — waiting for the recorder blob…");
  setState({ phase: "processing" });
  await recorderWin.webContents.executeJavaScript("window.vcStop()", true).catch((e) => {
    logError("vcStop failed:", String(e));
  });
  // the blob has to arrive within 20s — without it finalizeSession (and the
  // annotations detach inside it) never runs and the drawing window stays on screen
  setTimeout(() => {
    if (state.phase !== "processing") return;
    logError("stop: recorder blob didn't arrive within 20s — discarding the session");
    void annotations.detach();
    cleanupAfterStop();
    emit({ type: "session-error", message: "recorder didn't deliver the video — session discarded" });
  }, 20_000).unref?.();
  return { ok: true };
}

export async function cancelRecording(): Promise<{ ok: boolean }> {
  if (recorderWin && !recorderWin.isDestroyed()) {
    await recorderWin.webContents.executeJavaScript("window.vcCancel()", true).catch(() => {});
  }
  void annotations.detach(); // canceled: session won't be saved, buffer discarded
  cleanupAfterStop();
  return { ok: true };
}

export async function addMarker(): Promise<{ ok: boolean }> {
  if (state.phase !== "recording" || state.arming || !state.startedAt) return { ok: false };
  state.markers.push(Date.now());
  emit({ type: "state", state: { ...state } });
  // D6: marker becomes a context anchor — shot with the markers burned in
  void annotations.marker(state.markers.length);
  return { ok: true };
}

export function setPaused(p: boolean): void {
  if (state.arming) return; // no MediaRecorder yet — state would desync
  if (recorderWin && !recorderWin.isDestroyed()) {
    void recorderWin.webContents.executeJavaScript(`window.vcPause(${p})`, true).catch(() => {});
    setState({ paused: p });
  }
}

// Ctrl+M only exists while recording (doesn't steal the key day-to-day)
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

/** Retention: deletes sessions older than N days on boot (default 30). */
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
