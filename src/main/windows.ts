/**
 * Gestão de janelas do voicecast: picker, overlay de região, barra REC e o
 * renderer oculto de captura (MediaRecorder roda lá, padrão validado na F0).
 */
import { BrowserWindow, screen, ipcMain } from "electron";
import path from "node:path";
import type { Rect } from "../shared/ipc";

const dist = (...p: string[]) => path.join(__dirname, "../renderer", ...p);
const preload = () => path.join(__dirname, "../preload/index.js");

const webPrefs = {
  preload: preload(),
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
};

/** Manda console/crash do renderer para o log do main. */
function wireLogging(w: BrowserWindow, tag: string): void {
  const { logInfo, logError } = require("./logging") as typeof import("./logging");
  w.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    logInfo(`[${tag} renderer] ${message} (${sourceId}:${line})`);
  });
  w.webContents.on("preload-error", (_e, p, err) => {
    logError(`[${tag} preload-error] ${p}:`, err);
  });
  w.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logError(`[${tag} did-fail-load] ${code} ${desc} ${url}`);
  });
  w.webContents.on("render-process-gone", (_e, details) => {
    logError(`[${tag} render-gone]`, details.reason, details.exitCode);
  });
}

export function createPicker(): BrowserWindow {
  const w = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    autoHideMenuBar: true,
    title: "voicecast",
    backgroundColor: "#101014",
    webPreferences: webPrefs,
  });
  w.loadFile(dist("index.html"));
  wireLogging(w, "picker");
  return w;
}

/**
 * Overlay fullscreen de seleção de região num display específico.
 * Resolves com o retângulo em px FÍSICOS (ou null = cancelado).
 */
export function selectRegionOnDisplay(displayIndex = 0): Promise<Rect | null> {
  const displays = screen.getAllDisplays();
  const d = displays[displayIndex] ?? screen.getPrimaryDisplay();

  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      ...d.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      enableLargerThanScreen: true,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { ...webPrefs, preload: preload() },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");

    let settled = false;
    const done = (rect: Rect | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        overlay.destroy();
      } catch {}
      resolve(rect);
    };

    const ch = `region:result:${Date.now()}`;
    ipcMain.once(ch, (_e, rect: Rect | null) => done(rect));
    const timer = setTimeout(() => done(null), 120_000); // 2min sem ação → cancela

    void overlay.loadFile(dist("overlay.html"), { query: { ch, dpr: String(d.scaleFactor) } });
    wireLogging(overlay, "overlay");
    overlay.show();
    overlay.focus();
  });
}

/** Barra compacta frameless sempre-no-topo durante a gravação. */
export function createBar(modeLabel: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 460,
    height: 56,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#0c0c10",
    webPreferences: webPrefs,
  });
  w.setAlwaysOnTop(true, "screen-saver");
  void w.loadFile(dist("bar.html"), { query: { mode: modeLabel } });
  wireLogging(w, "bar");
  w.show();
  return w;
}

/** Editor de sessão (M2): player + transcrição + clipes + contexto. */
export function createEditor(dir: string, name: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    title: `voicecast · ${name}`,
    backgroundColor: "#101014",
    webPreferences: webPrefs,
  });
  void w.loadFile(dist("editor.html"), { query: { dir, name } });
  wireLogging(w, "editor");
  w.show();
  return w;
}

/** Renderer oculto do ditado (mic-only, mesma página do recorder, modo=ditado). */
export function createDitado(blobChannel: string): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    webPreferences: webPrefs,
  });
  void w.loadFile(dist("recorder.html"), { query: { ch: blobChannel, mode: "ditado" } });
  wireLogging(w, "ditado");
  return w;
}

/** Renderer oculto que roda o getUserMedia(desktop)+MediaRecorder. */
export function createRecorder(blobChannel: string): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    webPreferences: webPrefs,
  });
  void w.loadFile(dist("recorder.html"), { query: { ch: blobChannel } });
  wireLogging(w, "recorder");
  return w;
}
