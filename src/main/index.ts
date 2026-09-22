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
import { createPicker, createEditor } from "./windows";
import { ensureLayout } from "./storage";
import { initLogging, logError, logInfo } from "./logging";
import { registerDitadoHotkey, claimHotkey, toggleDitado } from "./ditado";
import { initTelemetry } from "./telemetry";
import {
  asrHealth,
} from "./asr";
import {
  buildContext,
  captureFrame,
  copyToClipboard,
  createClip,
  deleteSession,
  getSessionDetail,
  listSessions,
  openInFolder,
  searchSessions,
  transcribeAndStore,
  updateSessionMeta,
} from "./library";

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
  ipcMain.handle(IPC.asrStatus, () => asrHealth());
  ipcMain.handle(IPC.listSessions, (_e, query?: string) => searchSessions(query ?? ""));
  ipcMain.handle(IPC.getSession, (_e, dir: string, name: string) => {
    const d = getSessionDetail(dir, name);
    if (!d) return null;
    const mediaFile = d.mp4 || d.audio;
    return {
      dir,
      name,
      meta: d.meta,
      transcript: d.transcript,
      mediaUrl: mediaFile ? "file:///" + mediaFile.replace(/\\/g, "/") : null,
      mediaKind: d.mp4 ? "video" : d.audio ? "audio" : null,
    };
  });
  ipcMain.handle(IPC.updateSession, (_e, dir: string, name: string, patch: { title?: string; tags?: string[] }) => {
    updateSessionMeta(dir, name, patch);
    return { ok: true } as const;
  });
  ipcMain.handle(IPC.deleteSession, (_e, dir: string, name: string) => {
    deleteSession(dir, name);
    return { ok: true } as const;
  });
  ipcMain.handle(IPC.transcribeSession, async (_e, dir: string, name: string) => {
    const ok = await transcribeAndStore(dir, name);
    return ok ? { ok: true } as const : { ok: false, error: "transcrição falhou (ASR indisponível?)" };
  });
  ipcMain.handle(IPC.createClip, async (_e, dir: string, name: string, inS: number, outS: number, label?: string) => {
    const r = await createClip(dir, name, inS, outS, label);
    return "error" in r ? { ok: false, error: r.error } : { ok: true, file: r.file, bytes: r.bytes };
  });
  ipcMain.handle(IPC.captureFrame, async (_e, dir: string, name: string, atS: number) => {
    const r = await captureFrame(dir, name, atS);
    return "error" in r ? { ok: false, error: r.error } : { ok: true, file: r.file };
  });
  ipcMain.handle(IPC.buildContext, async (_e, dir: string, name: string, range?: { inS: number; outS: number } | null) => {
    const r = await buildContext({ dir, name, range });
    return "error" in r ? { ok: false, error: r.error } : { ok: true, markdown: r.markdown };
  });
  ipcMain.handle(IPC.copyText, (_e, text: string) => {
    copyToClipboard(text);
    return { ok: true } as const;
  });
  ipcMain.handle(IPC.openPath, (_e, winPath: string) => {
    openInFolder(winPath);
    return { ok: true } as const;
  });
  ipcMain.handle(IPC.openEditor, (_e, dir: string, name: string) => {
    createEditor(dir, name);
    return { ok: true } as const;
  });
  ipcMain.handle(IPC.ditadoToggle, () => toggleDitado());

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
    // telemetria DEPOIS do probe do daemon: o import do SDK OTel bloqueia o
    // event loop por alguns segundos e faria o probe de 2s expirar à toa
    setTimeout(() => void initTelemetry(), 3000);
    ensureLayout();
    applyRetention();
    registerIpc();
    subscribeEvents((e) => {
      broadcast(e);
      // M2: sessão finalizada → dispara transcrição automática em background
      if (e.type === "session-done") {
        void transcribeAndStore(e.dir, e.name).then((ok) => {
          broadcast({ type: "session-done", dir: e.dir, name: e.name, mp4: e.mp4 });
          if (!ok) logInfo("transcrição automática ficou pendente (retranscreva no editor)");
        });
      }
    });

    if (!globalShortcut.register("Control+F9", togglePicker)) {
      logError("Ctrl+F9 não pôde ser registrado");
    }
    globalShortcut.register("Control+Shift+F9", () => {
      void recordFullscreen();
    });

    // Ditado F9 (v2): só assume o F9 se o daemon suportar hold (patch novo)
    // ou não existir. Daemon velho (sem endpoint) → F9 fica com ele.
    void (async () => {
      try {
        const r = await fetch("http://127.0.0.1:8700/api/external/hold", {
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const claimed = await claimHotkey(true);
          if (claimed) {
            registerDitadoHotkey();
            logInfo("posse do F9 transferida ao voicecast (daemon renova por TTL)");
          } else {
            logInfo("daemon não aceitou a posse do F9 — tecla permanece com ele");
          }
        } else {
          logInfo(`daemon velho (HTTP ${r.status}) — F9 permanece no voice-dictation`);
        }
      } catch {
        registerDitadoHotkey(); // sem daemon: v2 completa, F9 é nosso
        logInfo("daemon ausente — F9 assumido pelo voicecast");
      }
    })();

    if (process.argv.includes("--dev") || process.env.VOICECAST_DEV === "1") {
      logInfo("--dev: abrindo picker");
      pickerWindow().show();
    }

    // --open-editor=YYYY-MM-DD/hhmm-hash abre o editor direto (debug/usuário)
    const openEd = process.argv.find((a) => a.startsWith("--open-editor="));
    if (openEd) {
      const [dir, name] = openEd.split("=")[1]!.split("/");
      if (dir && name) createEditor(dir, name);
    }

    // --transcribe=YYYY-MM-DD/hhmm-hash transcreve a sessão e sai (sem janela/som)
    const tr = process.argv.find((a) => a.startsWith("--transcribe="));
    if (tr) {
      const [dir, name] = tr.split("=")[1]!.split("/");
      void transcribeAndStore(dir, name).then((ok) => {
        logInfo(`--transcribe ${dir}/${name}: ${ok ? "ok" : "falhou"}`);
        app.exit(ok ? 0 : 1);
      });
    }

    // gancho de teste determinístico: ditado F9 start→6s→stop sem tecla física.
    // Determinístico com VOICECAST_DITADO_FAKE_TEXT (pula o ASR); sem o env,
    // transcreve o mic de verdade. Sai sozinho no fim.
    if (process.argv.includes("--ditado-test")) {
      setTimeout(async () => {
        logInfo("[ditado-test] start");
        const a = await toggleDitado();
        logInfo(`[ditado-test] inicio: ${JSON.stringify(a)}`);
        setTimeout(async () => {
          const b = await toggleDitado();
          logInfo(`[ditado-test] fim: ${JSON.stringify(b)}`);
          setTimeout(() => app.exit(0), 5000); // margem: Jev + save + barra
        }, 6000);
      }, 3000);
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
    void claimHotkey(false); // devolve o F9 ao daemon
  });

  // fechar janela ≠ sair (o app vive nos atalhos globais)
  app.on("window-all-closed", () => {
    /* intencional */
  });
  process.on("SIGINT", () => app.exit(0));
}

void path;
