/**
 * Ditado (F9) — o modo v2 que absorve o voice-dictation.
 *
 * F9 toggle: captura mic-only SEM janela (zero roubo de foco), no stop envia
 * o wav ao ASR :8701 e cola o texto na janela que estava em foco (clipboard +
 * Ctrl+V sintético). Antes de capturar, segura o F9 do daemon via hold no
 * :8700 (v2 transição); sem daemon, funciona igual (nada para suspender).
 */
import { BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import { transcribeAudioFile } from "./asr";
import { logError, logInfo } from "./logging";
import { createDitado, createBar } from "./windows";
import { saveDictationSession } from "./library";
import { counter, histogram, withSpan } from "./telemetry";
import { Buffer } from "node:buffer";
import { IPC, type CaptureEvent } from "../shared/ipc";

const M_DICTATIONS = counter("voicecast_dictations_total", "ditados por status");
const H_TRANSCRIBE = histogram("voicecast_transcribe_seconds", "duração da transcrição ASR");

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
let hotkeyRegistered = false;

export function ditadoState(): DictationState {
  return state;
}

// ── hold no daemon (:8700) ─────────────────────────────────────

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
    return false; // daemon não existe (v2 completa) — ok
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

// ── posse do F9 (heartbeat TTL — se o voicecast morrer, o F9 volta ao daemon) ──

let heartbeatTimer: NodeJS.Timeout | null = null;

/** Reivindica (claim=true) ou devolve (claim=false) a posse do F9 no daemon. */
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

// ── barra de feedback (sem roubar foco) ────────────────────────

function startDitadoBar(): void {
  const { screen } = require("electron") as typeof import("electron");
  const d = screen.getPrimaryDisplay();
  barWin = createBar("Ditado", { ditado: true });
  const b = barWin.getBounds();
  barWin.setPosition(d.workArea.x + d.workArea.width - b.width - 18, d.workArea.y + d.workArea.height - b.height - 18);
  barWin.showInactive(); // aparece SEM tomar foco — o Ctrl+V cola onde você estava
}

function closeDitadoBar(): void {
  if (barWin && !barWin.isDestroyed()) barWin.close();
  barWin = null;
}

// ── captura mic-only (renderer oculto, sem foco) ───────────────

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
    return { ok: false, error: result?.error ?? "captura de mic falhou" };
  }
  return { ok: true };
}

async function stopCaptureWindow(): Promise<void> {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;
}

// ── colagem na janela focada (clipboard + Ctrl+V sintético) ────

async function pasteToFocused(text: string): Promise<void> {
  clipboard.writeText(text);
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  // SendWait entrega o Ctrl+V à janela em foco (voicecast nunca rouba o foco)
  const ps = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ],
    { stdio: "ignore", detached: true },
  );
  ps.unref();
  logInfo(`ditado: colado ${text.length} chars via Ctrl+V sintético`);
}

// ── toggle F9 ──────────────────────────────────────────────────

export async function toggleDitado(): Promise<{ ok: boolean; error?: string }> {
  if (state === "idle") {
    if (await daemonRecording()) {
      return { ok: false, error: "ditado do daemon em andamento — espere terminar" };
    }
    const held = await daemonHold(true);
    logInfo(`ditado: início (daemon hold ${held ? "aplicado" : "ausente"})`);
    state = "recording";
    ditadoStartedAt = Date.now();
    startDitadoBar();
    broadcast({ type: "ditado-state", phase: "recording" });
    const cap = await startCapture();
    if (!cap.ok) {
      state = "idle";
      closeDitadoBar();
      await daemonHold(false);
      logError("ditado: captura falhou:", cap.error ?? "?");
      return cap;
    }
    return { ok: true };
  }

  if (state === "recording") {
    state = "transcribing";
    const startedAt = ditadoStartedAt;
    broadcast({ type: "ditado-state", phase: "transcribing" });
    try {
      await withSpan("ditado.stop", { duration_s: +((Date.now() - startedAt) / 1000).toFixed(1) }, async () => {
        recorderWin?.webContents.executeJavaScript("window.vcStopDictation()", true).catch(() => {});
        const payload = await (blobPromise ?? Promise.resolve({ b64: "", ext: "webm" }));
        await stopCaptureWindow();

        // o ASR só engole wav/pcm estáveis → extrai wav do webm via ffmpeg
        const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const tmpDir = mkdtempSync(join(tmpdir(), "vc-ditado-"));
        const src = join(tmpDir, `ditado.${payload.ext}`);
        writeFileSync(src, Buffer.from(payload.b64, "base64"));
        const t0 = Date.now();
        const t = await transcribeAudioFile(src);
        H_TRANSCRIBE?.record((Date.now() - t0) / 1000, { kind: "ditado" });
        rmSync(tmpDir, { recursive: true, force: true });
        const text = t.text.trim();

        // v2: ditado com fala vira sessão de áudio na biblioteca; silêncio descarta
        if (text) {
          try {
            saveDictationSession(startedAt, payload.ext, payload.b64, t);
          } catch (e) {
            logError("ditado: falhou ao salvar histórico:", e);
          }
        } else {
          logInfo("ditado: nada reconhecido — não salva histórico");
        }

        if (text) await pasteToFocused(text);
        M_DICTATIONS?.add(1, { status: text ? "ok" : "vazio" });
      });
      return { ok: true };
    } catch (e) {
      M_DICTATIONS?.add(1, { status: "erro" });
      logError("ditado: transcrição/colagem falhou:", e);
      return { ok: false, error: String(e) };
    } finally {
      await daemonHold(false);
      closeDitadoBar();
      state = "idle";
    }
  }
  return { ok: false, error: "ditado transcrevendo — aguarde" };
}

export function registerDitadoHotkey(): void {
  if (hotkeyRegistered) return;
  globalShortcut.register("F9", () => {
    void toggleDitado();
  });
  hotkeyRegistered = true;
  logInfo("ditado: F9 registrado no voicecast");
}
