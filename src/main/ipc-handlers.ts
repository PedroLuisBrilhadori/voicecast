/**
 * Main process IPC handler registration (renderer → main invoke/send channels).
 * Called once from index.ts inside app.whenReady.
 */
import { app, ipcMain } from "electron";
import {
  IPC,
  type Bootstrap,
  type PingRequest,
  type PingResponse,
  type SaveCorrectionRequest,
  type SessionMetaPatch,
  type SessionSegment,
  type StartRecordingRequest,
} from "../shared/ipc";
import type { AgentBridge } from "./agent/bridge";
import { broadcast } from "./broadcast";
import {
  addMarker,
  cancelRecording,
  getState,
  listSources,
  selectRegion,
  setPaused,
  startRecording,
  stopRecording,
} from "./capture";
import { createEditor } from "./windows";
import { toggleDitado } from "./ditado";
import { asrAutoEnableIfNeeded, asrHostStatus, setAsrHostEnabled } from "./asr-host";
import { asrHealth } from "./asr";
import {
  buildContext,
  captureFrame,
  copyToClipboard,
  createClip,
  deleteSession,
  exportCut,
  getSessionDetail,
  listClips,
  openInFolder,
  saveCorrection,
  searchSessions,
  transcribeAndStore,
  updateSessionMeta,
} from "./library";
import { getDatasetItem, listDatasetItems, writeDatasetCorrection } from "./dataset";

export function registerIpc(agent: AgentBridge, shortcuts: Bootstrap["shortcuts"]): void {
  ipcMain.handle(IPC.ping, (_e, req: PingRequest): PingResponse => ({ nonce: req.nonce, at: Date.now() }));
  ipcMain.handle(IPC.getBootstrap, (): Bootstrap => ({
    version: app.getVersion(),
    platform: process.platform as Bootstrap["platform"],
    shortcuts,
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
