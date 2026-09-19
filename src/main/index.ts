/**
 * Processo principal: lifecycle, atalhos globais, registro de IPC.
 *
 * Atalhos: Ctrl+F9 painel · Ctrl+Shift+F9 gravar tela cheia · Ctrl+M marker (só durante REC)
 */
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import {
  IPC,
  type Bootstrap,
  type CaptureEvent,
  type PingRequest,
  type PingResponse,
  type StartRecordingRequest,
} from "../shared/ipc";
import {
  addMarker,
  applyRetention,
  cancelRecording,
  getState,
  listSources,
  selectRegion,
  setPaused,
  startRecording,
  stopRecording,
  subscribeEvents,
} from "./capture";
import { createPicker } from "./windows";
import { ensureLayout } from "./storage";
import { initLogging, logError, logInfo } from "./logging";

initLogging();
logInfo("boot voicecast: argv=", process.argv, "pid=", process.pid);

const SHORTCUTS: Bootstrap["shortcuts"] = {
  togglePanel: "Ctrl+F9",
  recordFullscreen: "Ctrl+Shift+F9",
};

let picker: BrowserWindow | null = null;

function broadcast(e: CaptureEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.event, e);
  }
}

function pickerWindow(): BrowserWindow {
  if (picker && !picker.isDestroyed()) return picker;
  picker = createPicker();
  picker.on("closed", () => {
    picker = null;
  });
  return picker;
}

function togglePicker(): void {
  const w = pickerWindow();
  if (w.isVisible()) w.hide();
  else {
    w.show();
    w.focus();
  }
}

async function recordFullscreen(): Promise<void> {
  // toggle: inicia tela cheia; se já gravando, para (permite operar por teclado só)
  const st = getState();
  if (st.phase !== "idle") {
    await stopRecording();
    return;
  }
  const sources = await listSources("screen");
  const primary = sources[0];
  if (primary) await startRecording({ mode: "screen", sourceId: primary.id, withMic: true });
}

function registerIpc(): void {
  ipcMain.handle(IPC.ping, (_e, req: PingRequest): PingResponse => ({ nonce: req.nonce, at: Date.now() }));
  ipcMain.handle(IPC.getBootstrap, (): Bootstrap => ({
    version: app.getVersion(),
    platform: process.platform as Bootstrap["platform"],
    shortcuts: SHORTCUTS,
  }));
  ipcMain.handle(IPC.listSources, (_e, kind: "screen" | "window") => listSources(kind));
  ipcMain.handle(IPC.selectRegion, (_e, displayIndex?: number) => selectRegion(displayIndex));
  ipcMain.handle(IPC.startRecording, (_e, req: StartRecordingRequest) => startRecording(req));
  ipcMain.handle(IPC.stopRecording, () => stopRecording());
  ipcMain.handle(IPC.cancelRecording, () => cancelRecording());
  ipcMain.handle(IPC.addMarker, () => addMarker());
  ipcMain.handle(IPC.pause, (_e, paused: boolean) => {
    setPaused(paused);
    return { ok: true };
  });
  ipcMain.handle(IPC.getState, () => getState());
  ipcMain.on(IPC.micLevel, (_e, level: number) => {
    broadcast({ type: "mic-level", level });
  });
}

const gotLock = app.requestSingleInstanceLock();
logInfo("single-instance lock:", gotLock);
if (!gotLock) {
  logInfo("outra instância já roda — saindo");
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = pickerWindow();
    w.show();
    w.focus();
  });

  app.whenReady().then(() => {
    logInfo("whenReady: registrando IPC/atalhos…");
    ensureLayout();
    applyRetention();
    registerIpc();
    subscribeEvents(broadcast);

    if (!globalShortcut.register("Control+F9", togglePicker)) {
      logError("Ctrl+F9 não pôde ser registrado");
    }
    globalShortcut.register("Control+Shift+F9", () => {
      void recordFullscreen();
    });

    if (process.argv.includes("--dev") || process.env.VOICECAST_DEV === "1") {
      logInfo("--dev: abrindo picker");
      pickerWindow().show();
    }

    // gancho de teste determinístico: grava 8s fullscreen+mic com um marker e para
    if (process.argv.includes("--autotest")) {
      setTimeout(async () => {
        logInfo("[autotest] start fullscreen+mic");
        await recordFullscreen();
        setTimeout(async () => {
          logInfo("[autotest] marker");
          await addMarker();
          logInfo("[autotest] stop");
          await stopRecording();
        }, 8_000);
      }, 2_500);
      // sai quando a sessão terminar de processar (ou timeout de segurança)
      const done = (e: CaptureEvent) => {
        if (e.type === "session-done" || e.type === "session-error") {
          logInfo(`[autotest] fim: ${e.type}`);
          setTimeout(() => app.exit(0), 500);
          clearTimeout(guard);
        }
      };
      const off = subscribeEvents(done);
      const guard = setTimeout(() => {
        off();
        logInfo("[autotest] timeout de segurança — saindo");
        app.exit(1);
      }, 120_000);
    }
  });

  app.on("render-process-gone", (_e, wc, details) => {
    logError("renderer gone:", wc.getProcessId(), details.reason, details.exitCode);
  });
  app.on("child-process-gone", (_e, details) => {
    logError("child gone:", details.type, details.reason, details.exitCode);
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  // fechar janela ≠ sair (o app vive nos atalhos globais)
  app.on("window-all-closed", () => {
    /* intencional */
  });
  process.on("SIGINT", () => app.exit(0));
}

void path;
