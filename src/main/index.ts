/**
 * Processo principal (M0): lifecycle, janela principal (picker), atalhos globais.
 *
 * Atalhos (definidos na F0 e mantidos):
 * - Ctrl+F9         → abre/traz à frente o painel de gravação integral
 * - Ctrl+Shift+F9   → (M1) gravar tela cheia imediatamente — placeholder
 */
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import { IPC, type Bootstrap, type PingRequest, type PingResponse } from "../shared/ipc";
import { ensureLayout } from "./storage";

const SHORTCUTS: Bootstrap["shortcuts"] = {
  togglePanel: "Ctrl+F9",
  recordFullscreen: "Ctrl+Shift+F9",
};

let picker: BrowserWindow | null = null;

function pickerWindow(): BrowserWindow {
  if (picker && !picker.isDestroyed()) return picker;
  picker = new BrowserWindow({
    width: 860,
    height: 560,
    show: false,
    autoHideMenuBar: true,
    title: "voicecast",
    backgroundColor: "#101014",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  picker.loadFile(path.join(__dirname, "../renderer/index.html"));
  picker.on("closed", () => {
    picker = null;
  });
  return picker;
}

function togglePicker(): void {
  const w = pickerWindow();
  if (w.isVisible()) {
    w.hide();
  } else {
    w.show();
    w.focus();
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.ping, (_e, req: PingRequest): PingResponse => {
    return { nonce: req.nonce, at: Date.now() };
  });
  ipcMain.handle(IPC.getBootstrap, (): Bootstrap => ({
    version: app.getVersion(),
    platform: process.platform as Bootstrap["platform"],
    shortcuts: SHORTCUTS,
  }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // segunda instância só traz a primeira à frente
    const w = pickerWindow();
    w.show();
    w.focus();
  });

  app.whenReady().then(() => {
    ensureLayout();
    registerIpc();

    if (!globalShortcut.register("Control+F9", togglePicker)) {
      console.error("[voicecast] Ctrl+F9 não pôde ser registrado");
    }

    // --dev (ou VOICECAST_DEV=1): abre o painel na hora, sem depender do atalho
    if (process.argv.includes("--dev") || process.env.VOICECAST_DEV === "1") {
      pickerWindow().show();
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  // fechar janela ≠ sair do app (fica no atalho global); Ctrl+Q sai de verdade
  app.on("window-all-closed", () => {
    /* intencional: app continua no tray de atalhos */
  });
  process.on("SIGINT", () => app.exit(0));
}
