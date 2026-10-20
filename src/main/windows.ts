/**
 * Gestão de janelas do voicecast: picker, overlay de região, barra REC e o
 * renderer oculto de captura (MediaRecorder roda lá, padrão validado na F0).
 */
import { BrowserWindow, screen, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { Rect } from "../shared/ipc";
import { appDataDir } from "./storage";

const dist = (...p: string[]) => path.join(__dirname, "../renderer", ...p);
const preload = () => path.join(__dirname, "../preload/index.js");

const webPrefs = {
  preload: preload(),
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
};

export { dist, preload, webPrefs };

/** Manda console/crash do renderer para o log do main. */
export function wireLogging(w: BrowserWindow, tag: string): void {
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
    height: 820,
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
 * Seleção de região em TODOS os displays de uma vez (padrão snipping tool):
 * um overlay fullscreen por monitor; o usuário ARRASTA no monitor que quiser
 * e SOLTAR confirma (mouse-first — Enter não participa). Esc/✕ cancela tudo.
 * Resolves {rect em px FÍSICOS, displayIndex} ou null = cancelado.
 */
export function selectRegionOnDisplays(): Promise<{ rect: Rect; displayIndex: number } | null> {
  const displays = screen.getAllDisplays();
  if (!displays.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    const overlays: Electron.BrowserWindow[] = [];
    let settled = false;
    const done = (result: { rect: Rect; displayIndex: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const o of overlays) {
        try {
          o.destroy();
        } catch {}
      }
      resolve(result);
    };

    const ch = `region:result:${Date.now()}`;
    ipcMain.once(ch, (_e, payload: { rect: Rect; displayIndex: number } | null) => done(payload));
    const timer = setTimeout(() => done(null), 120_000); // 2min sem ação → cancela

    displays.forEach((d, idx) => {
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
      overlays.push(overlay);
      void overlay.loadFile(dist("overlay.html"), {
        query: { ch, dpr: String(d.scaleFactor), idx: String(idx) },
      });
      wireLogging(overlay, "overlay");
      overlay.show();
      overlay.focus();
    });
  });
}

// ── posição da bar persistida entre sessões ────────────────────

const barBoundsFile = (): string => {
  try {
    return path.join(appDataDir(), "bar-position.json");
  } catch {
    return ""; // app não pronto (testes) — sem persistência
  }
};

/** Última posição salva da bar (ou null). Valida que ainda está visível em alguma tela. */
export function loadSavedBarBounds(): Rect | null {
  const f = barBoundsFile();
  if (!f) return null;
  try {
    const b = JSON.parse(fs.readFileSync(f, "utf8")) as Rect;
    const onScreen = screen.getAllDisplays().some((d) => {
      const { x, y, width, height } = d.bounds;
      return b.x + b.width > x + 40 && b.x < x + width - 40 && b.y + b.height > y + 10 && b.y < y + height - 10;
    });
    return onScreen ? b : null;
  } catch {
    return null;
  }
}

function saveBarBounds(w: BrowserWindow): void {
  const f = barBoundsFile();
  if (!f || w.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(w.getBounds()));
  } catch {}
}

/** Barra compacta frameless sempre-no-topo durante a gravação.
 *  opts.ditado: botões viram toggle do ditado; caller decide show() vs showInactive().
 *  Restaura a última posição arrastada pelo usuário (bar-position.json); sem
 *  posição salva nasce no default do SO. */
export function createBar(
  modeLabel: string,
  opts: { ditado?: boolean } = {},
): BrowserWindow {
  const saved = loadSavedBarBounds();
  const w = new BrowserWindow({
    width: opts.ditado ? 300 : 460,
    height: 56,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: !opts.ditado, // ditado: janela NÃO focável (não rouba nem mantém foco)
    hasShadow: true,
    backgroundColor: "#0c0c10",
    webPreferences: webPrefs,
  });
  w.setAlwaysOnTop(true, "screen-saver");
  void w.loadFile(dist("bar.html"), {
    query: { mode: modeLabel, ...(opts.ditado ? { ditado: "1" } : {}) },
  });
  wireLogging(w, "bar");
  let saveTimer: NodeJS.Timeout | null = null;
  const persist = () => {
    clearTimeout(saveTimer!);
    saveTimer = setTimeout(() => saveBarBounds(w), 300);
  };
  w.on("moved", persist);
  w.on("close", persist);
  // ditado: NUNCA show() — no KWin/XWayland a barra mapeada com show() toma o
  // foco do teclado (apesar de focusable:false) e o Ctrl+V do paste cai nela
  // em vez do campo do usuário. showInactive mapeia sem ativar.
  if (opts.ditado) w.showInactive();
  else w.show();
  return w;
}

/**
 * Editor de sessão (M2): player + transcrição + clipes + contexto.
 * corpus !== undefined abre a janela no modo dataset do voice (W2a — tela de
 * correção que substitui o painel :8700): corpus="" é a lista, corpus=<id>
 * abre o detalhe do item direto.
 */
export function createEditor(dir: string, name: string, corpus?: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    title: corpus !== undefined ? "voicecast · dataset" : `voicecast · ${name}`,
    backgroundColor: "#101014",
    webPreferences: webPrefs,
  });
  void w.loadFile(dist("editor.html"), {
    query: corpus !== undefined ? { corpus } : { dir, name },
  });
  wireLogging(w, "editor");
  // show() sem focus() nasce atrás da janela ativa — a tela do dataset ficava
  // invisível (o usuário via só a janela que já estava na frente)
  w.show();
  w.focus();
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
