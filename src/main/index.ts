/**
 * Main process: lifecycle, global shortcuts, IPC registration.
 *
 * Shortcuts: Ctrl+F9 panel · Ctrl+Shift+F9 record fullscreen · Ctrl+M marker (only during REC)
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
import { asrAutoEnableIfNeeded, asrHostStatus, ensureAsrHost, setAsrHostEnabled, stopAsrHost } from "./asr-host";
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

/** C4: cockpit smoke mode (--agenttest "goal") — states printed to stdout. */
const agenttestMode = process.argv.includes("--agenttest");

/** Cockpit bridge (utilityProcess) — created on whenReady, stopped on will-quit. */
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
    // hide/show doesn't remount the React — the session list may be stale
    // (e.g., title edited in the editor). Reopening always reloads.
    w.webContents.send(IPC.event, { type: "sessions-changed" });
  }
}

async function recordFullscreen(): Promise<void> {
  // toggle: starts fullscreen; if already recording, stops (lets you operate by keyboard only)
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
  // transcription model switch (settings.json; turning off takes the service down)
  ipcMain.handle(IPC.asrHostGet, () => asrHostStatus());
  ipcMain.handle(IPC.asrHostSet, (_e, on: boolean) => setAsrHostEnabled(Boolean(on)));
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
    // EXPLICIT transcription request re-enables the model (settings switch; env no)
    await asrAutoEnableIfNeeded();
    const ok = await transcribeAndStore(dir, name);
    return ok ? { ok: true } as const : { ok: false, error: "transcription failed (ASR unavailable?)" };
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
  // W2a — dictation corrections: saves into the session (transcript+meta) and, when the
  // session is linked (meta.datasetId), also into the voice corpus
  ipcMain.handle(IPC.saveCorrection, (_e, dir: string, name: string, req: SaveCorrectionRequest) => {
    const r = saveCorrection(dir, name, typeof req === "object" && req ? req : { correctedText: "", edits: [] });
    if (r.ok) broadcast({ type: "sessions-changed" }); // the list preview may have changed
    return r;
  });
  ipcMain.handle(IPC.openCorpus, (_e, id?: string) => {
    createEditor("", "", typeof id === "string" ? id : "");
    return { ok: true } as const;
  });
  // W2a — voice training dataset (same corpus the JSONL export consumes)
  ipcMain.handle(IPC.listDatasetItems, (_e, query?: string, labeled?: "any" | "0" | "1") =>
    listDatasetItems({ query, labeled }),
  );
  ipcMain.handle(IPC.getDatasetItem, (_e, id: string) => getDatasetItem(String(id ?? "")));
  ipcMain.handle(IPC.saveDatasetCorrection, (_e, id: string, req: SaveCorrectionRequest) => {
    const clean = typeof req === "object" && req ? req : { correctedText: "", edits: [] };
    const corrected = String(clean.correctedText ?? "").replace(/\s+/g, " ").trim();
    if (!corrected) return { ok: false, error: "empty correction" } as const;
    const status = writeDatasetCorrection(String(id ?? ""), corrected, clean.edits ?? []);
    if (status === "ok") {
      return { ok: true, alvo: "dataset", dataset: "ok" } as const;
    }
    return {
      ok: false,
      error:
        status === "ausente"
          ? "voice dataset not found (VOICECAST_DATASET_DIR / %LOCALAPPDATA%\\voice-dictation\\datasets)"
          : "failed to write to the dataset (nothing was truncated)",
    } as const;
  });
  ipcMain.handle(IPC.ditadoToggle, () => toggleDitado());
  // C4 — agent cockpit: enqueue in the worker (states arrive via agent-state broadcast)
  ipcMain.handle(IPC.agentRunGoal, (_e, goal: string) => agent.enqueue(typeof goal === "string" ? goal : ""));
  ipcMain.handle(IPC.agentGetState, () => agent.lastState());

  ipcMain.on(IPC.micLevel, (_e, level: number) => {
    broadcast({ type: "mic-level", level });
  });
}

const gotLock = app.requestSingleInstanceLock();
logInfo("single-instance lock:", gotLock);
if (!gotLock) {
  logInfo("another instance already running — exiting");
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // KDE hooks: kcm_keys custom shortcuts call run-linux.sh with
    // --ditado/--rec; the 2nd instance signals this one and exits (parity with the
    // Windows exe --mostrar/--soltar)
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
    logInfo("whenReady: registering IPC/shortcuts…");
    // transcription backend (spawn+supervision) — the model loads in the background.
    // --agenttest doesn't bring it up (cockpit smoke with no side effects).
    if (!agenttestMode) void ensureAsrHost();
    // C4: cockpit bridge — each transition becomes a broadcast for the bar/panel and,
    // on --agenttest, a stdout line (deterministic Windows gate hook).
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
    // telemetry right after boot: the old scheduling (idle+15s) was
    // mitigation for the SDK import that blocked the event loop for ~9s — post-W1 the
    // SDK runs in a worker_thread and init blocks nothing (residual 2s delay,
    // idle guard kept so it doesn't compete with a session boot).
    scheduleTelemetryInit(() => getState().phase, () => void initTelemetry());
    ensureLayout();
    applyRetention();
    registerIpc(agentBridge);
    subscribeEvents((e) => {
      broadcast(e);
      // M2: session finalized → triggers automatic background transcription
      if (e.type === "session-done") {
        void transcribeAndStore(e.dir, e.name).then((ok) => {
          broadcast({ type: "session-done", dir: e.dir, name: e.name, mp4: e.mp4 });
          if (!ok) logInfo("automatic transcription left pending (re-transcribe in the editor)");
        });
      }
    });

    if (!globalShortcut.register("Control+F9", togglePicker)) {
      logError("Ctrl+F9 could not be registered");
    }
    const recordFullscreenHotkey = (): void => {
      void recordFullscreen();
    };
    globalShortcut.register("Control+Shift+F9", recordFullscreenHotkey);
    // Ctrl+Alt+H is global to the app (not only with the overlay active): without a panel it opens
    // the standalone panel (outside a session); with a panel, it hides/shows the palette
    if (!globalShortcut.register("Control+Alt+H", () => annotations.onPaletteHotkey())) {
      logError("Ctrl+Alt+H could not be registered");
    }

    // Wayland/portal: the GlobalShortcutsPortal backend is only ready after
    // boot — a shortcut registered too early leaks to the X11 path (no-op
    // on Wayland) and dies without an error (annotations, registered late, always
    // worked). Re-registers the main ones once the portal is up.
    setTimeout(() => {
      globalShortcut.unregister("Control+F9");
      globalShortcut.unregister("Control+Shift+F9");
      globalShortcut.unregister("Control+Alt+H");
      const ok = globalShortcut.register("Control+F9", togglePicker)
        && globalShortcut.register("Control+Shift+F9", recordFullscreenHotkey)
        && globalShortcut.register("Control+Alt+H", () => annotations.onPaletteHotkey());
      logInfo(`main shortcuts re-registered via portal (ok=${ok})`);
      globalShortcut.unregister("F9");
      registerDitadoHotkey();
    }, 2500);

    // Dictation F9 (v2): only takes over F9 if the daemon supports hold (new patch)
    // or doesn't exist. Old daemon (no endpoint) → F9 stays with it.
    void (async () => {
      try {
        const r = await fetch("http://127.0.0.1:8700/api/external/hold", {
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const claimed = await claimHotkey(true);
          if (claimed) {
            registerDitadoHotkey();
            logInfo("F9 ownership transferred to voicecast (daemon renews by TTL)");
          } else {
            logInfo("daemon didn't accept F9 ownership — the key stays with it");
          }
        } else {
          logInfo(`old daemon (HTTP ${r.status}) — F9 remains with voice-dictation`);
        }
      } catch {
        registerDitadoHotkey(); // no daemon: v2 complete, F9 is ours
        logInfo("daemon absent — F9 taken over by voicecast");
      }
    })();

    if (process.argv.includes("--dev") || process.env.VOICECAST_DEV === "1") {
      logInfo("--dev: opening picker");
      pickerWindow().show();
    }

    // --open-editor=YYYY-MM-DD/hhmm-hash opens the editor directly (debug/user)
    const openEd = process.argv.find((a) => a.startsWith("--open-editor="));
    if (openEd) {
      const [dir, name] = openEd.split("=")[1]!.split("/");
      if (dir && name) createEditor(dir, name);
    }

    // --open-corpus[=<id>] opens the voice dataset correction screen (W2a;
    // without an id opens the list — replaces the :8700 panel)
    const openCs = process.argv.find((a) => a.startsWith("--open-corpus"));
    if (openCs) {
      const id = openCs.includes("=") ? openCs.split("=")[1]! : "";
      createEditor("", "", id);
    }

    // --transcribe=YYYY-MM-DD/hhmm-hash transcribes the session and exits (no window/sound)
    const tr = process.argv.find((a) => a.startsWith("--transcribe="));
    if (tr) {
      const [dir, name] = tr.split("=")[1]!.split("/");
      void asrAutoEnableIfNeeded()
        .then(() => transcribeAndStore(dir, name))
        .then((ok) => {
          logInfo(`--transcribe ${dir}/${name}: ${ok ? "ok" : "failed"}`);
          void stopTelemetry().finally(() => app.exit(ok ? 0 : 1));
        });
    }

    // deterministic test hook for annotations (AN): simulates dictation with
    // a synthetic burst (stroke+laser) → validates jsonl + burned-in auto-print.
    if (process.argv.includes("--anotest")) {
      setTimeout(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const { annotations } = await import("./annotations.js");
        const { sessionDirs } = await import("./storage.js");
        const { sessionDirName } = await import("../shared/paths.js");
        logInfo("[anotest] attach dictation + overlay");
        annotations.attach("ditado", Date.now(), null);
        await sleep(2500); // overlay load
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
        logInfo(`[anotest] synthetic events: seq ${ev1?.seq}/${ev1 ? ev1.seq + 1 : "?"}`);
        await sleep(4500); // 2s debounce + composite
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

    // annotations UI hook: overlay open for 90s to drive real mouse/
    // keyboard (UX validation by agent). Persists at the end and exits.
    if (process.argv.includes("--anoui")) {
      setTimeout(async () => {
        const { annotations } = await import("./annotations.js");
        const { sessionDirs } = await import("./storage.js");
        const { sessionDirName } = await import("../shared/paths.js");
        logInfo("[anoui] overlay open for 90s — drive the mouse");
        // palette visible: the test drives the palette itself (drag, tools)
        annotations.attach("session", Date.now(), null, { paletteOn: true });
        setTimeout(async () => {
          const now = new Date();
          const dayDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          const name = sessionDirName(now, `anoui:${Date.now()}:${Math.random()}`);
          await annotations.detach(sessionDirs(dayDir, name));
          logInfo("[anoui] end");
          app.exit(0);
        }, 90_000);
      }, 3000);
    }

    // AN.6 — scroll-through (INVISIBLE: no new windows). The wheel target is
    // the visible picker itself. Validates: renderer bridge → IPC → user32
    // (WindowFromPoint finds a target != overlay, PostMessage ok). The final
    // effect (the app below scrolling) is verified in the human pass.
    if (process.argv.includes("--wheeltest")) {
      setTimeout(async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const { annotations } = await import("./annotations.js");
        annotations.attach("session", Date.now(), null);
        await sleep(2500); // overlay load (starts in pass-through)
        annotations.enterDrawMode("brush"); // draw mode: overlay captures the wheel
        await sleep(500);
        const overlay = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("annotation.html"),
        );
        if (!overlay) {
          logError("[wheeltest] overlay not found");
          app.exit(1);
          return;
        }
        const bridge = await overlay.webContents.executeJavaScript(
          "typeof window.vcInternal?.annotationWheel",
        );
        // counter of wheels that REACH the renderer (growing without sending = repost loop)
        await overlay.webContents.executeJavaScript(
          "window.__wheelN = 0; window.addEventListener('wheel', () => window.__wheelN++, {passive: false}); 0",
        );
        const wheelCount = () => overlay.webContents.executeJavaScript("window.__wheelN");
        const wins = BrowserWindow.getAllWindows().map((w) => ({
          hwnd: w.getNativeWindowHandle().readBigUInt64LE(0),
          page: (w.webContents.getURL().split("/").pop() ?? "?").slice(0, 30),
          visivel: w.isVisible(),
        }));
        logInfo(`[wheeltest] bridge=${bridge} windows=${JSON.stringify(wins)}`);
        // 3 downward bursts at screen center (sendInputEvent inverts the sign)
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(300);
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(300);
        overlay.webContents.sendInputEvent({ type: "mouseWheel", x: 450, y: 400, deltaX: 0, deltaY: -200 });
        await sleep(400);
        const n1 = await wheelCount(); // end of bursts
        await sleep(1000);
        const n2 = await wheelCount(); // 1s later: if it grew without sending → loop
        logInfo(`[wheeltest] wheelsDOM end=${n1} +1s=${n2} (loop if n2 >> n1)`);
        await annotations.detach(null);
        app.exit(bridge === "function" && n1 > 0 && n2 <= n1 + 5 ? 0 : 1);
      }, 3000);
    }

    // deterministic test hook: dictation F9 start→6s→stop without a physical key.

    // deterministic test hook: dictation F9 start→6s→stop without a physical key.
    // Deterministic with VOICECAST_DITADO_FAKE_TEXT (skips the ASR); without the env,
    // transcribes the real mic. Exits by itself at the end.
    if (process.argv.includes("--ditado-test")) {
      setTimeout(async () => {
        logInfo("[ditado-test] start");
        const a = await toggleDitado();
        logInfo(`[ditado-test] start: ${JSON.stringify(a)}`);
        setTimeout(async () => {
          const b = await toggleDitado();
          logInfo(`[ditado-test] end: ${JSON.stringify(b)}`);
          setTimeout(() => app.exit(0), 5000); // margin: Jev + save + bar
        }, 6000);
      }, 3000);
    }

    // deterministic test hook: records 8s fullscreen+mic with one marker and stops
    if (process.argv.includes("--autotest")) {
      setTimeout(async () => {
        // init BEFORE measuring: the autotest validates the stable path (in real
        // use telemetry came up long before the first recording)
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
      // exits when the session finishes processing (or safety timeout)
      const done = (e: CaptureEvent) => {
        if (e.type === "session-done" || e.type === "session-error") {
          logInfo(`[autotest] end: ${e.type}`);
          // margin for the OTel flush (otherwise app.exit loses the cycle's metrics)
          setTimeout(() => {
            void stopTelemetry().finally(() => app.exit(0));
          }, 1_000);
          clearTimeout(guard);
        }
      };
      const off = subscribeEvents(done);
      const guard = setTimeout(() => {
        off();
        logInfo("[autotest] safety timeout — exiting");
        app.exit(1);
      }, 120_000);
    }

    // C4 — cockpit deterministic test hook: enqueues a goal in the
    // bridge (utilityProcess), prints the states to stdout and exits (exit 0 =
    // completed). Runs on Windows (maintainer gate); the protocol itself gets
    // smoked on WSL by the worker tests. Determinism: ZCODE_AGENT_BIN
    // points to a fake binary (e.g., tests/fixtures/fake-agent.sh on WSL) — without
    // the override, runs the real C2b runtime.
    if (agenttestMode) {
      const idx = process.argv.indexOf("--agenttest");
      const goalArg = process.argv[idx + 1];
      const goal = goalArg && !goalArg.startsWith("--") ? goalArg : "Responda somente: ok";
      setTimeout(async () => {
        await initTelemetry(); // bridge counter + worker-relayed telemetry
        logInfo(`[agenttest] enqueueing goal: ${goal}`);
        const r = agentBridge?.enqueue(goal);
        if (!r?.ok) {
          console.log(`[agenttest] enqueue failed: ${r && "error" in r ? r.error : "bridge missing"}`);
          void stopTelemetry().finally(() => app.exit(1));
          return;
        }
        console.log(`[agenttest] goal enqueued: ${r.id}`);
        // safety guard: runner without an answer within timeout+30s → exit 1
        setTimeout(
          () => {
            console.log("[agenttest] safety timeout — exiting");
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
    void claimHotkey(false); // gives F9 back to the daemon
    void stopTelemetry(); // OTel flush (best-effort — smokes call it directly)
    stopAsrHost(); // takes down the python service we started
    agentBridge?.stop(); // C4: shuts down the cockpit utilityProcess
  });

  // closing the window ≠ exiting (the app lives in the global shortcuts)
  app.on("window-all-closed", () => {
    /* intencional */
  });
  process.on("SIGINT", () => app.exit(0));
}

void path;
