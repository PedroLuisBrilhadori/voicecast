/**
 * Ditado (F9) — o modo v2 que absorve o voice-dictation.
 *
 * F9 toggle: captura mic-only SEM janela (zero roubo de foco), no stop envia
 * o wav ao ASR :8701 e cola o texto na janela que estava em foco (clipboard +
 * Ctrl+V sintético). Antes de capturar, segura o F9 do daemon via hold no
 * :8700 (v2 transição); sem daemon, funciona igual (nada para suspender).
 */
import { clipboard, globalShortcut, ipcMain } from "electron";
import { transcribeSession } from "./asr";
import { logError, logInfo } from "./logging";
import { createDitado } from "./windows";

type DictationState = "idle" | "recording" | "transcribing";

let state: DictationState = "idle";
let recorderWin: Electron.BrowserWindow | null = null;
let blobPromise: Promise<{ b64: string; ext: string }> | null = null;
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
    const cap = await startCapture();
    if (!cap.ok) {
      state = "idle";
      await daemonHold(false);
      logError("ditado: captura falhou:", cap.error ?? "?");
      return cap;
    }
    return { ok: true };
  }

  if (state === "recording") {
    state = "transcribing";
    try {
      recorderWin?.webContents.executeJavaScript("window.vcStopDictation()", true).catch(() => {});
      const payload = await (blobPromise ?? Promise.resolve({ b64: "", ext: "wav" }));
      await stopCaptureWindow();

      const wav = Buffer.from(payload.b64, "base64");
      const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmp = join(mkdtempSync(join(tmpdir(), "vc-ditado-")), "ditado.wav");
      writeFileSync(tmp, wav);

      const t = await transcribeSession(tmp);
      rmSync(tmp, { force: true });
      const text = t.text.trim();
      if (text) await pasteToFocused(text);
      else logInfo("ditado: nada reconhecido");
      return { ok: true };
    } catch (e) {
      logError("ditado: transcrição/colagem falhou:", e);
      return { ok: false, error: String(e) };
    } finally {
      await daemonHold(false);
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
