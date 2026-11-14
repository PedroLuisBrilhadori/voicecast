/**
 * Dictation (F9) — the v2 mode that absorbs voice-dictation.
 *
 * F9 toggle: captures mic-only WITHOUT a window (zero focus stealing), on stop sends
 * the wav to ASR :8701 and pastes the text into the window that was in focus (clipboard +
 * synthetic Ctrl+V). Before capturing, holds the daemon's F9 via hold on
 * :8700 (v2 transition); without a daemon, works the same (nothing to suspend).
 */
import { BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import { asrHealth, asrModelStatus, transcribeAudioFile, type Transcript } from "./asr";
import { asrAutoEnableIfNeeded, asrHostStatus, backendPython, backendSrc } from "./asr-host";
import { logError, logInfo } from "./logging";
import { createDitado, createBar, loadSavedBarBounds } from "./windows";
import { saveDictationSession } from "./library";
import { counter, histogram, withSpan } from "./telemetry";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { IPC, type CaptureEvent } from "../shared/ipc";
import { decidePaste, judgeDictation } from "./jev";
import { annotations } from "./annotations";
import { sessionDirs } from "./storage";

const M_DICTATIONS = counter("voicecast_dictations_total", "dictations by status");
const M_ASR_COLD = counter("voicecast_asr_model_cold_total", "transcriptions that waited for model load (post-boot cold start)");
const H_TRANSCRIBE = histogram("voicecast_transcribe_seconds", "ASR transcription duration");

function broadcast(e: CaptureEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.event, e);
  }
}

type DictationState = "idle" | "recording" | "transcribing";

let state: DictationState = "idle";
let recorderWin: Electron.BrowserWindow | null = null;
let barWin: Electron.BrowserWindow | null = null;
let blobPromise: Promise<{ b64: string; ext: string }> | null = null;
let ditadoStartedAt = 0;
let ditadoHwnd = 0;
let hotkeyRegistered = false;
/** F9 re-enabled the transcription model in this dictation (background spawn
 *  since start) — stop waits for the port to open before transcribing. */
let ditadoAsrLigadoAgora = false;

export function ditadoState(): DictationState {
  return state;
}

// ── daemon hold (:8700) ─────────────────────────────────────

function panelUrl(): string {
  return (process.env.VOICE_PANEL_URL || "http://127.0.0.1:8700").replace(/\/$/, "");
}

async function daemonHold(on: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/external/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on, owner: "voicecast" }),
      signal: AbortSignal.timeout(2500),
    });
    if (r.ok) {
      const j = (await r.json()) as { held: boolean };
      logInfo(`daemon hold ${on ? "ON" : "OFF"} (held=${j.held})`);
      return true;
    }
    return false;
  } catch {
    return false; // daemon doesn't exist (v2 complete) — ok
  }
}

async function daemonRecording(): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { state?: string };
    return j.state === "recording" || j.state === "transcribing";
  } catch {
    return false;
  }
}

// ── F9 ownership (heartbeat TTL — if voicecast dies, F9 goes back to the daemon) ──

let heartbeatTimer: NodeJS.Timeout | null = null;

/** Claims (claim=true) or gives back (claim=false) F9 ownership at the daemon. */
export async function claimHotkey(claim: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/external/hotkey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim ? { owner: "voicecast", ttl_s: 60 } : { owner: null }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return false;
    if (claim && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        void fetch(`${panelUrl()}/api/external/hotkey`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: "voicecast", ttl_s: 60 }),
          signal: AbortSignal.timeout(2500),
        }).catch(() => {});
      }, 20_000);
      heartbeatTimer.unref?.();
    }
    if (!claim && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return true;
  } catch {
    return false;
  }
}

// ── feedback bar (without stealing focus) ────────────────────────

function startDitadoBar(): void {
  const { screen } = require("electron") as typeof import("electron");
  barWin = createBar("Dictation", { ditado: true });
  if (!loadSavedBarBounds()) {
    // first time: bottom-right corner; after that, wherever the user dragged it wins
    const d = screen.getPrimaryDisplay();
    const b = barWin.getBounds();
    barWin.setPosition(d.workArea.x + d.workArea.width - b.width - 18, d.workArea.y + d.workArea.height - b.height - 18);
  }
  barWin.showInactive(); // appears WITHOUT taking focus — Ctrl+V pastes where you were
}

function closeDitadoBar(): void {
  if (barWin && !barWin.isDestroyed()) barWin.close();
  barWin = null;
}

// ── mic-only capture (hidden renderer, no focus) ───────────────

async function startCapture(): Promise<{ ok: boolean; error?: string }> {
  const ch = `ditado:blob:${Date.now()}`;
  blobPromise = new Promise((res) => {
    ipcMain.once(ch, (_e, payload: { b64: string; ext: string }) => res(payload));
  });

  const win = createDitado(ch);
  recorderWin = win;
  await new Promise<void>((res) => {
    const wc = win.webContents;
    if (wc.isLoading()) wc.once("did-finish-load", () => res());
    else res();
  });

  const result = (await win.webContents.executeJavaScript(
    `window.vcRecordDictation()`,
    false,
  )) as { ok: boolean; error?: string };
  if (!result?.ok) {
    await stopCaptureWindow();
    return { ok: false, error: result?.error ?? "mic capture failed" };
  }
  return { ok: true };
}

async function stopCaptureWindow(): Promise<void> {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;
}

// ── paste into the focused window (clipboard + synthetic Ctrl+V) ────

// ── paste into the focused window: the daemon's PROVEN CODE (v2 reuses it) ──
// paste_into_focused (win32.py): clipboard + SendInput scan codes (struct
// INPUT cbSize 40) + refocus of the HWND captured at dictation start + fallback
// unicode. Same behavior as the old F9, literally the same code.

function voicePython(): string | null {
  // voicecast backend first (win: %LOCALAPPDATA%, linux: XDG_DATA_HOME —
  // asr-host.ts is the source of truth for the layout); legacy voice-dictation as
  // fallback on Windows
  const viaBackend = backendPython();
  if (viaBackend) return viaBackend;
  const local = process.env.LOCALAPPDATA ?? "";
  const legado = path.join(local, "voice-dictation", ".venv", "Scripts", "python.exe");
  return fs.existsSync(legado) ? legado : null;
}

function voiceSrc(): string {
  const viaBackend = backendSrc();
  if (viaBackend) return viaBackend;
  const local = process.env.LOCALAPPDATA ?? "";
  return path.join(local, "voice-dictation", "src");
}

export function pythonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // VOICE_APP_DIR aligns the python app_dir() to the backend data root;
  // PYTHONUTF8/PYTHONIOENCODING: Node writes stdin in UTF-8 but Python on
  // Windows decodes with the console codepage (cp1252) → pasted text came out
  // mojibake ("Não"→"NÃ£o"). Forces UTF-8 on both sides of the pipe.
  const out: NodeJS.ProcessEnv = { ...env };
  const backendDir = path.join(process.env.LOCALAPPDATA ?? "", "voicecast", "asr-backend");
  if (fs.existsSync(backendDir)) out.VOICE_APP_DIR = backendDir;
  out.PYTHONUTF8 = "1";
  out.PYTHONIOENCODING = "utf-8";
  return out;
}

function spawnHidden(cmd: string, args: string[]) {
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: pythonEnv(),
  });
}

async function captureForegroundHwnd(): Promise<number> {
  const py = voicePython();
  if (!py) return 0;
  return new Promise((res) => {
    const script =
      `import sys; sys.path.insert(0, r"${voiceSrc()}"); ` +
      "from voice.platform import get_backend; print(get_backend().foreground_hwnd())";
    const child = spawnHidden(py, ["-c", script]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => res(0));
    child.on("exit", () => res(parseInt(out.trim(), 10) || 0));
    setTimeout(() => res(0), 5000);
  });
}

/**
 * Pastes via the daemon's paste_into_focused (stdin = text, argv1 = target hwnd).
 * Returns the USED mode ("clipboard"/"unicode") or null if python didn't even run —
 * the stdout text ("usado: <mode>") is the truth: exit 0 alone doesn't guarantee
 * the Ctrl+V landed (the "...-falhou"/"ctrl-v-bloqueado" modes exit with 0).
 */
async function pasteViaDaemonCode(text: string, hwnd: number): Promise<string | null> {
  const py = voicePython();
  if (!py) return null;
  return new Promise((res) => {
    const script =
      "import logging, sys\n" +
      // without basicConfig the platform log.info is discarded (no handler) —
      // and it's what carries the focus/clipboard registration diagnostics
      "logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(message)s')\n" +
      `sys.path.insert(0, r"${voiceSrc()}"); ` +
      "from voice.platform import get_backend\n" +
      "text = sys.stdin.read()\n" +
      `used = get_backend().paste_into_focused(text, "auto", ${hwnd})\n` +
      'print("usado:", used, "chars:", len(text))';
    const child = spawnHidden(py, ["-c", script]);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.stdin?.end(text);
    child.on("error", () => res(null));
    child.on("exit", (code) => {
      const m = out.match(/usado:\s*(\S+)/);
      if (code !== 0) logError(`[paste] python exited ${code}: ${err.slice(-300)}`);
      else if (m) logInfo(`[paste] ${m[1]} chars: ${text.length}`);
      // python logs valuable diagnostics to stderr (active focus at paste time,
      // clipboard registration, wtype/ydotool rc) — always log it
      if (err.trim() && code === 0) logInfo(`[paste] diag: ${err.trim().slice(-400).replace(/\n+/g, " | ")}`);
      res(code === 0 && m ? m[1] : null);
    });
  });
}

async function pasteToFocused(text: string, hwnd: number): Promise<void> {
  // seeds the clipboard through Electron too (X11/XWayland): X targets receive
  // the native paste, and KWin mirrors it to Wayland — belt and suspenders
  // with the backend's wl-copy (the other namespace may win the race)
  clipboard.writeText(text);
  // main path: the daemon's proven code (HWND refocus + SendInput)
  const used = await pasteViaDaemonCode(text, hwnd);
  if (used && !/falhou|bloqueado/.test(used)) return;
  // daemon unavailable or failed: last resort on Windows only (clipboard +
  // SendKeys). On Linux this fallback doesn't exist (powershell = ENOENT) — the
  // daemon failure modes leave the text ON THE CLIPBOARD, pasteable by hand.
  if (process.platform === "win32") {
    clipboard.writeText(text);
    logInfo("ditado: daemon paste unavailable — SendKeys fallback");
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
      ],
      { stdio: "ignore", detached: true, windowsHide: true },
    );
    ps.on("error", (e) => logError("ditado: SendKeys fallback failed:", e));
    ps.unref();
    logInfo(`ditado: fallback pasted ${text.length} chars`);
    return;
  }
  logError(
    `[paste] paste NOT confirmed in the focused window (mode=${used ?? "python missing"}) — ` +
    "text stayed on the clipboard, paste with Ctrl+V",
  );
}

// ── F9 toggle ──────────────────────────────────────────────────

export async function toggleDitado(): Promise<{ ok: boolean; error?: string }> {
  if (state === "idle") {
    // BAR FIRST: the daemon (retired) checks used to cost up to ~4.5s of
    // timeout BEFORE the bar was born — on cold start F9 looked dead. The
    // checks stay, but without blocking the UX (a live daemon is a historical case).
    state = "recording";
    ditadoStartedAt = Date.now();
    // F9 is an EXPLICIT transcription request: with the switch off (settings source),
    // it re-enables the model on its own — the spawn runs while the user speaks. Env
    // VOICECAST_ASR_HOST=0 is not overridden (machine-level kill-switch).
    const st = asrHostStatus();
    if (!st.enabled && st.source === "settings") {
      ditadoAsrLigadoAgora = true;
      logInfo("ditado: transcription was off — re-enabling the model (settings switch)");
      void asrAutoEnableIfNeeded();
    }
    void (async () => {
      if (await daemonRecording()) {
        logError("ditado: daemon recording — aborting capture for safety");
        state = "idle";
        closeDitadoBar();
        broadcast({ type: "ditado-state", phase: "done" });
        return;
      }
      const held = await daemonHold(true);
      logInfo(`ditado: start (daemon hold ${held ? "applied" : "absent"})`);
    })();
    // HWND of the window in focus NOW — the paste refocuses it, even if you
    // switch windows while whisper transcribes (daemon behavior)
    void captureForegroundHwnd().then((h) => {
      ditadoHwnd = h;
      logInfo(`ditado: paste target hwnd=${h}`);
    });
    startDitadoBar();
    // AN: annotation overlay in dictation too (transcription-only mode) —
    // annotating triggers an automatic burned-in shot (D7); buffered until the dir exists.
    // Standalone panel opened earlier? It's adopted (pre-dictation strokes join).
    annotations.beginSession("ditado", ditadoStartedAt);
    broadcast({ type: "ditado-state", phase: "recording" });
    const cap = await startCapture();
    if (!cap.ok) {
      state = "idle";
      closeDitadoBar();
      await daemonHold(false);
      logError("ditado: capture failed:", cap.error ?? "?");
      return cap;
    }
    return { ok: true };
  }

  if (state === "recording") {
    state = "transcribing";
    const startedAt = ditadoStartedAt;
    // Cold start visibility (maintainer request): if the ASR model
    // is still loading (first use post-boot), the bar says WHY
    // transcription is slow — with the estimate the service itself calibrates.
    const model = await asrModelStatus();
    const asrLoading = model ? !model.loaded : false;
    if (asrLoading) M_ASR_COLD?.add(1);
    broadcast({
      type: "ditado-state",
      phase: "transcribing",
      asrLoading,
      expectedLoadS: model?.expectedLoadS,
    });
    const poll = setInterval(async () => {
      if (state !== "transcribing") return clearInterval(poll);
      const m = await asrModelStatus();
      if (m && m.loaded) {
        clearInterval(poll);
        broadcast({ type: "ditado-state", phase: "transcribing", asrLoading: false });
      }
    }, 2500);
    try {
      await withSpan("ditado.stop", { duration_s: +((Date.now() - startedAt) / 1000).toFixed(1) }, async () => {
        // did we re-enable the model at start? wait for the port to open (the spawn has been
        // running since then; model load continues after — the bar shows "loading")
        if (ditadoAsrLigadoAgora) {
          const h = await asrHealth({ waitMs: 25_000 });
          if (!h.ok) logError("ditado: ASR didn't open the port after re-enable — audio stays pending");
        }
        ditadoAsrLigadoAgora = false;
        recorderWin?.webContents.executeJavaScript("window.vcStopDictation()", true).catch(() => {});
        const payload = await (blobPromise ?? Promise.resolve({ b64: "", ext: "webm" }));
        await stopCaptureWindow();

        // the ASR only swallows stable wav/pcm → extracts wav from webm via ffmpeg
        const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const tmpDir = mkdtempSync(join(tmpdir(), "vc-ditado-"));
        const src = join(tmpDir, `ditado.${payload.ext}`);
        writeFileSync(src, Buffer.from(payload.b64, "base64"));
      const t0 = Date.now();
      // E2E test hook: VOICECAST_DITADO_FAKE_TEXT skips the ASR (fixed text)
      const fake = process.env.VOICECAST_DITADO_FAKE_TEXT;
      // a failed transcription does NOT discard the speech: t = null → audio saved pending
      let t: Transcript | null = null;
      let asrErro: string | null = null;
      try {
        t = fake
          ? {
              text: fake,
              language: "pt",
              words: [],
              segments: [],
              transcribedAt: new Date().toISOString(),
              model: "fake",
            }
          : await transcribeAudioFile(src);
      } catch (e) {
        asrErro = String(e);
        logError("ditado: transcription failed — audio goes to the library as pending:", e);
      }
      if (t) H_TRANSCRIBE?.record((Date.now() - t0) / 1000, { kind: "ditado" });
        rmSync(tmpDir, { recursive: true, force: true });
        const text = t?.text.trim() ?? "";

        // Jev (PLANO-JEV-CU step 2): routes the intent BEFORE pasting —
        // agent commands, annotations, and conversation don't belong in the focused window.
        // Fail-soft: without judgment (off/no key/error) pastes like it always did.
        const j = text ? await judgeDictation(text) : null;
        const acao = decidePaste(j);

        // v2: dictation with speech becomes an audio session in the library; silence
        // is discarded; ASR unavailable saves ONLY the audio (pending transcription)
        let saved: { dir: string; name: string } | null = null;
        if (text || asrErro) {
          try {
            saved = saveDictationSession(startedAt, payload.ext, payload.b64, t, j);
          } catch (e) {
            logError("ditado: failed to save history:", e);
          }
        } else {
          logInfo("ditado: nothing recognized — history not saved");
        }
        // dictation annotations: persists log + burned-in shots into the saved session
        // (the pending auto-print flush happens BEFORE closing the overlay)
        await annotations.detach(saved ? sessionDirs(saved.dir, saved.name) : null);

        // panel/library: a saved dictation is a list change (without this the picker
        // list goes stale — hide/show doesn't remount the React)
        if (saved) broadcast({ type: "sessions-changed" });

        if (text && acao.paste) {
          await pasteToFocused(text, ditadoHwnd);
        } else if (text) {
          logInfo(`ditado: NOT pasted — route ${j?.rota} (conf ${j?.confidence?.toFixed(2) ?? "?"})`);
        }
        const pendente = !text && asrErro && saved !== null;
        M_DICTATIONS?.add(1, { status: text ? (acao.paste ? "ok" : `rota:${j?.rota ?? "?"}`) : pendente ? "sem-asr" : "vazio" });
        // the bar shows the outcome before closing (finally) — when nothing is
        // pasted (or transcription failed), the user needs to know WHY
        broadcast({
          type: "ditado-state",
          phase: "done",
          rota: j?.rota,
          conf: j?.confidence,
          colado: text ? acao.paste : undefined,
          pendente: pendente || undefined,
        });
        if (text) await new Promise((r) => setTimeout(r, acao.paste ? 350 : 2200));
        else if (pendente) await new Promise((r) => setTimeout(r, 2500));
      });
      return { ok: true };
    } catch (e) {
      M_DICTATIONS?.add(1, { status: "erro" });
      logError("ditado: transcription/paste failed:", e);
      // the annotations overlay (attached at start) can't stay stuck on screen
      // when transcription fails — same discard as cancel
      if (annotations.active) await annotations.detach();
      return { ok: false, error: String(e) };
    } finally {
      clearInterval(poll);
      await daemonHold(false);
      closeDitadoBar();
      state = "idle";
    }
  }
  return { ok: false, error: "dictation is transcribing — wait" };
}

export function registerDitadoHotkey(): void {
  if (hotkeyRegistered) return;
  globalShortcut.register("F9", () => {
    void toggleDitado();
  });
  hotkeyRegistered = true;
  logInfo("ditado: F9 registered in voicecast");
}
