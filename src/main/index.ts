/**
 * Processo principal: lifecycle, atalhos globais, registro de IPC.
 *
 * Atalhos: Ctrl+F9 painel · Ctrl+Shift+F9 gravar tela cheia · Ctrl+M marker (só durante REC)
 */
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerAnnotationIpc, annotations } from "./annotations";
import {
  IPC,
  type Bootstrap,
  type CaptureEvent,
  type PingRequest,
  type PingResponse,
  type SessionMetaPatch,
  type SessionSegment,
  type StartRecordingRequest,
} from "../shared/ipc";
import { isGoalFinal, goalSummary } from "../shared/agent-goal";
import { createAgentBridge, type AgentBridge } from "./agent/bridge";
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
import { initTelemetry, stopTelemetry } from "./telemetry";
import { scheduleTelemetryInit } from "../shared/telemetry-schedule";
import { ensureAsrHost, stopAsrHost } from "./asr-host";
import {
  asrHealth,
} from "./asr";
import {
  buildContext,
  captureFrame,
  copyToClipboard,
  createClip,
  deleteSession,
  exportCut,
  getSessionDetail,
  listClips,
  listSessions,
  openInFolder,
  saveCorrection,
  searchSessions,
  transcribeAndStore,
  updateSessionMeta,
} from "./library";
import { getDatasetItem, listDatasetItems, writeDatasetCorrection } from "./dataset";
import type { SaveCorrectionRequest } from "../shared/ipc";

initLogging();
logInfo("boot voicecast: argv=", process.argv, "pid=", process.pid);

const SHORTCUTS: Bootstrap["shortcuts"] = {
  togglePanel: "Ctrl+F9",
  recordFullscreen: "Ctrl+Shift+F9",
};

let picker: BrowserWindow | null = null;

/** C4: modo smoke do cockpit (--agenttest "goal") — estados impressos no stdout. */
const agenttestMode = process.argv.includes("--agenttest");

/** Ponte do cockpit (utilityProcess) — criada no whenReady, parada no will-quit. */
let agentBridge: AgentBridge | null = null;

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
    // hide/show não remonta o React — lista de sessões pode estar stale
    // (ex.: título editado no editor). Reabrir sempre recarrega.
    w.webContents.send(IPC.event, { type: "sessions-changed" });
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

function registerIpc(agent: AgentBridge): void {
  ipcMain.handle(IPC.ping, (_e, req: PingRequest): PingResponse => ({ nonce: req.nonce, at: Date.now() }));
  ipcMain.handle(IPC.getBootstrap, (): Bootstrap => ({
    version: app.getVersion(),
    platform: process.platform as Bootstrap["platform"],
    shortcuts: SHORTCUTS,
  }));
  ipcMain.handle(IPC.listSources, (_e, kind: "screen" | "window") => listSources(kind));
  ipcMain.handle(IPC.selectRegion, () => selectRegion());
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
  ipcMain.handle(IPC.updateSession, (_e, dir: string, name: string, patch: SessionMetaPatch) => {
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
  ipcMain.handle(IPC.listClips, (_e, dir: string, name: string) => listClips(dir, name));
  ipcMain.handle(IPC.exportCut, async (_e, dir: string, name: string, segments: SessionSegment[], label?: string) => {
    const r = await exportCut(dir, name, segments, label);
    return "error" in r ? { ok: false, error: r.error } : { ok: true, file: r.file, bytes: r.bytes };
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
  // W2a — correção de ditados: salva na sessão (transcript+meta) e, quando a
  // sessão está linkada (meta.datasetId), também no corpus do voice
  ipcMain.handle(IPC.saveCorrection, (_e, dir: string, name: string, req: SaveCorrectionRequest) => {
    const r = saveCorrection(dir, name, typeof req === "object" && req ? req : { correctedText: "", edits: [] });
    if (r.ok) broadcast({ type: "sessions-changed" }); // preview da lista pode ter mudado
    return r;
  });
  ipcMain.handle(IPC.openCorpus, (_e, id?: string) => {
    createEditor("", "", typeof id === "string" ? id : "");
    return { ok: true } as const;
  });
  // W2a — dataset de treino do voice (mesmo corpus que o export JSONL consome)
  ipcMain.handle(IPC.listDatasetItems, (_e, query?: string, labeled?: "any" | "0" | "1") =>
    listDatasetItems({ query, labeled }),
  );
  ipcMain.handle(IPC.getDatasetItem, (_e, id: string) => getDatasetItem(String(id ?? "")));
  ipcMain.handle(IPC.saveDatasetCorrection, (_e, id: string, req: SaveCorrectionRequest) => {
    const clean = typeof req === "object" && req ? req : { correctedText: "", edits: [] };
    const corrected = String(clean.correctedText ?? "").replace(/\s+/g, " ").trim();
    if (!corrected) return { ok: false, error: "correção vazia" } as const;
    const status = writeDatasetCorrection(String(id ?? ""), corrected, clean.edits ?? []);
    if (status === "ok") {
      return { ok: true, alvo: "dataset", dataset: "ok" } as const;
    }
    return {
      ok: false,
      error:
        status === "ausente"
          ? "dataset do voice não encontrado (VOICECAST_DATASET_DIR / %LOCALAPPDATA%\\voice-dictation\\datasets)"
          : "falha ao gravar no dataset (nada foi truncado)",
    } as const;
  });
  ipcMain.handle(IPC.ditadoToggle, () => toggleDitado());
  // C4 — cockpit de agente: enqueue no worker (estados chegam via broadcast agent-state)
  ipcMain.handle(IPC.agentRunGoal, (_e, goal: string) => agent.enqueue(typeof goal === "string" ? goal : ""));
  ipcMain.handle(IPC.agentGetState, () => agent.lastState());

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
  app.on("second-instance", (_e, argv) => {
    // ganchos KDE: atalhos customizados do kcm_keys chamam run-linux.sh com
    // --ditado/--rec; a 2ª instância sinaliza esta e sai (paridade com o exe
    // Windows --mostrar/--soltar)
    if (argv.includes("--ditado")) {
      void toggleDitado();
      return;
    }
    if (argv.includes("--rec")) {
      void recordFullscreen();
      return;
    }
    const w = pickerWindow();
    w.show();
    w.focus();
  });

  app.whenReady().then(() => {
    logInfo("whenReady: registrando IPC/atalhos…");
    // backend de transcrição (spawn+supervisão) — o modelo carrega em background.
    // --agenttest não o levanta (smoke do cockpit sem efeitos colaterais).
    if (!agenttestMode) void ensureAsrHost();
    // C4: ponte do cockpit — cada transição vira broadcast p/ barra/painel e,
    // no --agenttest, linha no stdout (gancho determinístico do gate Windows).
    agentBridge = createAgentBridge((s) => {
      broadcast({ type: "agent-state", state: s });
      if (agenttestMode) {
        console.log(`[agenttest] ${s.id} ${s.phase}: ${goalSummary(s)}${s.error ? ` — ${s.error}` : ""}`);
        if (isGoalFinal(s.phase)) {
          const code = s.phase === "completed" ? 0 : 1;
          void stopTelemetry().finally(() => app.exit(code));
        }
      }
    });
    registerAnnotationIpc();
    // telemetria logo após o boot: o agendamento antigo (idle+15s) era
    // mitigação do import do SDK que travava o event loop por ~9s — pós-W1 o
    // SDK roda em worker_thread e o init não bloqueia nada (delay 2s residual,
    // guarda de idle mantida p/ não competir com o boot de uma sessão).
    scheduleTelemetryInit(() => getState().phase, () => void initTelemetry());
    ensureLayout();
    applyRetention();
    registerIpc(agentBridge);
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
    const recordFullscreenHotkey = (): void => {
      void recordFullscreen();
    };
    globalShortcut.register("Control+Shift+F9", recordFullscreenHotkey);
    // Ctrl+Alt+H é global do app (não só com overlay ativa): sem painel abre o
    // painel standalone (fora de sessão); com painel, oculta/mostra a paleta
    if (!globalShortcut.register("Control+Alt+H", () => annotations.onPaletteHotkey())) {
      logError("Ctrl+Alt+H não pôde ser registrado");
    }

    // Wayland/portal: o backend de GlobalShortcutsPortal só está pronto depois
    // do boot — atalho registrado cedo demais escorre pro caminho X11 (no-op
    // no Wayland) e morre sem erro (as anotações, registradas tarde, sempre
    // funcionaram). Re-registra os principais quando o portal já estiver de pé.
    setTimeout(() => {
      globalShortcut.unregister("Control+F9");
      globalShortcut.unregister("Control+Shift+F9");
      globalShortcut.unregister("Control+Alt+H");
      const ok = globalShortcut.register("Control+F9", togglePicker)
        && globalShortcut.register("Control+Shift+F9", recordFullscreenHotkey)
        && globalShortcut.register("Control+Alt+H", () => annotations.onPaletteHotkey());
      logInfo(`atalhos principais re-registrados via portal (ok=${ok})`);
      globalShortcut.unregister("F9");
      registerDitadoHotkey();
    }, 2500);

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

    // --open-corpus[=<id>] abre a tela de correção do dataset do voice (W2a;
    // sem id abre a lista — substitui o painel :8700)
    const openCs = process.argv.find((a) => a.startsWith("--open-corpus"));
    if (openCs) {
      const id = openCs.includes("=") ? openCs.split("=")[1]! : "";
      createEditor("", "", id);
    }

    // --transcribe=YYYY-MM-DD/hhmm-hash transcreve a sessão e sai (sem janela/som)
    const tr = process.argv.find((a) => a.startsWith("--transcribe="));
    if (tr) {
      const [dir, name] = tr.split("=")[1]!.split("/");
      void transcribeAndStore(dir, name).then((ok) => {
        logInfo(`--transcribe ${dir}/${name}: ${ok ? "ok" : "falhou"}`);
        void stopTelemetry().finally(() => app.exit(ok ? 0 : 1));
      });
    }

    // gancho de teste determinístico das anotações (AN): simula ditado com
    // rajada sintética (stroke+laser) → valida jsonl + auto-print queimado.
    if (process.argv.includes("--anotest")) {
      setTimeout(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const { annotations } = await import("./annotations.js");
        const { sessionDirs } = await import("./storage.js");
        const { sessionDirName } = await import("../shared/paths.js");
        logInfo("[anotest] attach ditado + overlay");
        annotations.attach("ditado", Date.now(), null);
        await sleep(2500); // overlay carregar
        const ev1 = annotations.record({
          kind: "stroke",
          color: "#ff4444",
          width: 6,
          points: Array.from({ length: 40 }, (_, i) => ({
            x: 200 + i * 25,
            y: 300 + Math.round(60 * Math.sin(i / 4)),
            ms: i * 16,
          })),
        });
        annotations.record({
          kind: "laser",
          points: [
            { x: 400, y: 180, ms: 0 },
            { x: 700, y: 240, ms: 250 },
            { x: 1000, y: 200, ms: 500 },
          ],
        });
        logInfo(`[anotest] eventos sintéticos: seq ${ev1?.seq}/${ev1 ? ev1.seq + 1 : "?"}`);
        await sleep(4500); // debounce 2s + composite
        const now = new Date();
        const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const name = sessionDirName(now, `anotest:${Date.now()}:${Math.random()}`);
        const dirs = sessionDirs(dayDir, name);
        await annotations.detach(dirs);
        const jsonl = fs.existsSync(path.join(dirs.root, "annotations.jsonl"));
        const prints = fs.existsSync(dirs.frames) ? fs.readdirSync(dirs.frames) : [];
        logInfo(`[anotest] jsonl=${jsonl} prints=${prints.length} [${prints.join(", ")}]`);
        app.exit(jsonl && prints.length >= 1 ? 0 : 1);
      }, 3000);
    }

    // gancho de UI das anotações: overlay aberta por 90s p/ dirigir mouse/
    // teclado reais (validação de UX por agente). Persiste no fim e sai.
    if (process.argv.includes("--anoui")) {
      setTimeout(async () => {
        const { annotations } = await import("./annotations.js");
        const { sessionDirs } = await import("./storage.js");
        const { sessionDirName } = await import("../shared/paths.js");
        logInfo("[anoui] overlay aberta por 90s — dirija o mouse");
        // paleta visível: o teste dirige a própria paleta (arrastar, ferramentas)
        annotations.attach("session", Date.now(), null, { paletteOn: true });
        setTimeout(async () => {
          const now = new Date();
          const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const name = sessionDirName(now, `anoui:${Date.now()}:${Math.random()}`);
          await annotations.detach(sessionDirs(dayDir, name));
          logInfo("[anoui] fim");
          app.exit(0);
        }, 90_000);
      }, 3000);
    }

    // AN.6 — scroll-through (INVISÍVEL: sem janelas novas). O alvo da roda é
    // o próprio picker visível. Valida: bridge no renderer → IPC → user32
    // (WindowFromPoint acha alvo != overlay, PostMessage ok). O efeito final
    // (app de baixo rolar) é verificado no pass humano.
    if (process.argv.includes("--wheeltest")) {
      setTimeout(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const { annotations } = await import("./annotations.js");
        annotations.attach("session", Date.now(), null);
        await sleep(2500); // overlay carregar (inicia em pass-through)
        annotations.enterDrawMode("brush"); // modo desenho: overlay captura a roda
        await sleep(500);
        const overlay = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("annotation.html"),
        );
        if (!overlay) {
          logError("[wheeltest] overlay não encontrada");
          app.exit(1);
          return;
        }
        const bridge = await overlay.webContents.executeJavaScript(
          "typeof window.vcInternal?.annotationWheel",
        );
        // contador de wheels que CHEGAM no renderer (cresce sem envio = repost loop)
        await overlay.webContents.executeJavaScript(
          "window.__wheelN = 0; window.addEventListener('wheel', () => window.__wheelN++, {passive: false}); 0",
        );
        const wheelCount = () => overlay.webContents.executeJavaScript("window.__wheelN");
        const wins = BrowserWindow.getAllWindows().map((w) => ({
          hwnd: w.getNativeWindowHandle().readBigUInt64LE(0),
          page: (w.webContents.getURL().split("/").pop() ?? "?").slice(0, 30),
          visivel: w.isVisible(),
        }));
        logInfo(`[wheeltest] bridge=${bridge} janelas=${JSON.stringify(wins)}`);
        // 3 rajadas p/ baixo no centro da tela (sendInputEvent inverte o sinal)
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(300);
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(300);
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(400);
        const n1 = await wheelCount(); // fim das rajadas
        await sleep(1000);
        const n2 = await wheelCount(); // 1s depois: se cresceu sem envio → loop
        logInfo(`[wheeltest] wheelsDOM fim=${n1} +1s=${n2} (loop se n2 >> n1)`);
        await annotations.detach(null);
        app.exit(bridge === "function" && n1 > 0 && n2 <= n1 + 5 ? 0 : 1);
      }, 3000);
    }

    // gancho de teste determinístico: ditado F9 start→6s→stop sem tecla física.

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
        // init ANTES de medir: o autotest valida o caminho estável (em uso
        // real a telemetria já subiu muito antes da primeira gravação)
        await initTelemetry();
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
          // margem pro flush do OTel (senão o app.exit perde as métricas do ciclo)
          setTimeout(() => {
            void stopTelemetry().finally(() => app.exit(0));
          }, 1_000);
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

    // C4 — gancho de teste determinístico do cockpit: enfileira um goal no
    // bridge (utilityProcess), imprime os estados no stdout e sai (exit 0 =
    // completed). Roda no Windows (gate do mantenedor); o protocolo em si fica
    // smokeado no WSL pelos testes do worker. Determinismo: ZCODE_AGENT_BIN
    // aponta um binário fake (ex.: tests/fixtures/fake-agent.sh no WSL) — sem
    // override, roda o runtime C2b de verdade.
    if (agenttestMode) {
      const idx = process.argv.indexOf("--agenttest");
      const goalArg = process.argv[idx + 1];
      const goal = goalArg && !goalArg.startsWith("--") ? goalArg : "Responda somente: ok";
      setTimeout(async () => {
        await initTelemetry(); // counter da ponte + telemetria retransmitida do worker
        logInfo(`[agenttest] enfileirando goal: ${goal}`);
        const r = agentBridge?.enqueue(goal);
        if (!r?.ok) {
          console.log(`[agenttest] enqueue falhou: ${r && "error" in r ? r.error : "bridge ausente"}`);
          void stopTelemetry().finally(() => app.exit(1));
          return;
        }
        console.log(`[agenttest] goal enfileirado: ${r.id}`);
        // guard de segurança: runner sem resposta em timeout+30s → exit 1
        setTimeout(
          () => {
            console.log("[agenttest] timeout de segurança — saindo");
            void stopTelemetry().finally(() => app.exit(1));
          },
          (Number(process.env.ZCODE_AGENT_TIMEOUT_MS) || 15 * 60_000) + 30_000,
        );
      }, 2_000);
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
    void stopTelemetry(); // flush do OTel (best-effort — o smokes chamam direto)
    stopAsrHost(); // derruba o serviço python que subimos
    agentBridge?.stop(); // C4: encerra o utilityProcess do cockpit
  });

  // fechar janela ≠ sair (o app vive nos atalhos globais)
  app.on("window-all-closed", () => {
    /* intencional */
  });
  process.on("SIGINT", () => app.exit(0));
}

void path;
