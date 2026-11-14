/**
 * Preload: minimal typed bridge to the renderer (contextIsolation on).
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AnnotationCmd,
  type AnnotationEvent,
  type AnnotationEventRequest,
  type AnnotationWheelRequest,
  type Bootstrap,
  type CaptureEvent,
  type DatasetLabeledFilter,
  type PingRequest,
  type PingResponse,
  type RecordingState,
  type SaveCorrectionRequest,
  type SessionMetaPatch,
  type SessionSegment,
  type SourceInfo,
  type StartRecordingRequest,
  type VoicecastBridge,
} from "../shared/ipc";

const bridge: VoicecastBridge = {
  ping: (req: PingRequest): Promise<PingResponse> => ipcRenderer.invoke(IPC.ping, req),
  getBootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.getBootstrap),
  listSources: (kind: SourceInfo["kind"]): Promise<SourceInfo[]> =>
    ipcRenderer.invoke(IPC.listSources, kind),
  selectRegion: () => ipcRenderer.invoke(IPC.selectRegion),
  startRecording: (req: StartRecordingRequest) => ipcRenderer.invoke(IPC.startRecording, req),
  stopRecording: () => ipcRenderer.invoke(IPC.stopRecording),
  cancelRecording: () => ipcRenderer.invoke(IPC.cancelRecording),
  addMarker: () => ipcRenderer.invoke(IPC.addMarker),
  pause: (paused: boolean) => ipcRenderer.invoke(IPC.pause, paused),
  getState: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.getState),
  listSessions: (query?: string) => ipcRenderer.invoke(IPC.listSessions, query),
  getSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.getSession, dir, name),
  updateSession: (dir: string, name: string, patch: SessionMetaPatch) =>
    ipcRenderer.invoke(IPC.updateSession, dir, name, patch),
  deleteSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.deleteSession, dir, name),
  transcribeSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.transcribeSession, dir, name),
  createClip: (dir: string, name: string, inS: number, outS: number, label?: string) =>
    ipcRenderer.invoke(IPC.createClip, dir, name, inS, outS, label),
  captureFrame: (dir: string, name: string, atS: number) =>
    ipcRenderer.invoke(IPC.captureFrame, dir, name, atS),
  buildContext: (dir: string, name: string, range?: { inS: number; outS: number } | null) =>
    ipcRenderer.invoke(IPC.buildContext, dir, name, range),
  listClips: (dir: string, name: string) => ipcRenderer.invoke(IPC.listClips, dir, name),
  exportCut: (dir: string, name: string, segments: SessionSegment[], label?: string) =>
    ipcRenderer.invoke(IPC.exportCut, dir, name, segments, label),
  copyText: (text: string) => ipcRenderer.invoke(IPC.copyText, text),
  openPath: (winPath: string) => ipcRenderer.invoke(IPC.openPath, winPath),
  openEditor: (dir: string, name: string) => ipcRenderer.invoke(IPC.openEditor, dir, name),
  saveCorrection: (dir: string, name: string, req: SaveCorrectionRequest) =>
    ipcRenderer.invoke(IPC.saveCorrection, dir, name, req),
  openCorpus: (id?: string) => ipcRenderer.invoke(IPC.openCorpus, id),
  ditadoToggle: () => ipcRenderer.invoke(IPC.ditadoToggle),
  asrStatus: () => ipcRenderer.invoke(IPC.asrStatus),
  asrHostGet: () => ipcRenderer.invoke(IPC.asrHostGet),
  asrHostSet: (enabled: boolean) => ipcRenderer.invoke(IPC.asrHostSet, enabled),
  // W2a — voice training dataset
  listDatasetItems: (query?: string, labeled?: DatasetLabeledFilter) =>
    ipcRenderer.invoke(IPC.listDatasetItems, query, labeled),
  getDatasetItem: (id: string) => ipcRenderer.invoke(IPC.getDatasetItem, id),
  saveDatasetCorrection: (id: string, req: SaveCorrectionRequest) =>
    ipcRenderer.invoke(IPC.saveDatasetCorrection, id, req),
  // C4 — agent cockpit
  agentRunGoal: (goal: string) => ipcRenderer.invoke(IPC.agentRunGoal, goal),
  agentGetState: () => ipcRenderer.invoke(IPC.agentGetState),
  onEvent: (cb: (e: CaptureEvent) => void) => {
    const h = (_e: unknown, ev: CaptureEvent) => cb(ev);
    ipcRenderer.on(IPC.event, h);
    return () => ipcRenderer.removeListener(IPC.event, h);
  },
};

contextBridge.exposeInMainWorld("voicecast", bridge);

/** Extras only for internal capture pages (recorder/overlay/bar). */
contextBridge.exposeInMainWorld("vcInternal", {
  /** Recorder mic level (0..1). */
  micLevel: (level: number) => ipcRenderer.send(IPC.micLevel, level),
  /** Blob delivery on stop — channels restricted to capture prefixes. */
  sendBlob: (channel: string, payload: { b64: string; ext: string }) => {
    if (!channel.startsWith("recorder:blob:") && !channel.startsWith("ditado:blob:")) {
      throw new Error("unauthorized channel");
    }
    ipcRenderer.send(channel, payload);
  },
  /** Region overlay result (single channel per selection). */
  sendRegion: (channel: string, rect: unknown) => {
    if (!channel.startsWith("region:result:")) throw new Error("unauthorized channel");
    ipcRenderer.send(channel, rect);
  },
  // ── annotation overlay (AN.1/AN.2) ─────────────────────────
  /** Creates an annotation event — main assigns seq/t/ids and returns the event. */
  annotationEvent: (req: AnnotationEventRequest): Promise<AnnotationEvent | null> =>
    ipcRenderer.invoke(IPC.annotationEvent, req),
  /** Commands from main: tool, pass-through mode, capture for composite. */
  onAnnotationCmd: (cb: (cmd: AnnotationCmd) => void) => {
    const h = (_e: unknown, cmd: AnnotationCmd) => cb(cmd);
    ipcRenderer.on(IPC.annotationCmd, h);
    return () => ipcRenderer.removeListener(IPC.annotationCmd, h);
  },
  /** Burned-in PNG (b64) returned for a capture requested by main. */
  sendComposite: (id: string, b64: string) =>
    ipcRenderer.send(IPC.annotationComposite, { id, b64 }),
  /** Window mouse: palette hover (temporary), ESC (leave drawing), enter drawing via the palette or palette drag. */
  annotationMouse: (req: { mouse: boolean; from: "palette" | "esc" | "draw" | "drag"; tool?: import("../shared/annotations").AnnotationTool }) =>
    ipcRenderer.invoke(IPC.annotationMouse, req),
  /** Active strokes/lasers (sendSync — print path only). */
  annotationContext: (): {
    strokes: import("../shared/annotations").StrokeSnapshot[];
    lasers: { at: number; points: import("../shared/annotations").Pt[] }[];
  } => ipcRenderer.sendSync(IPC.annotationContext),
  /** Palette rectangle (CSS px) — main polls the cursor on top of it. */
  annotationPaletteBounds: (rect: { x: number; y: number; w: number; h: number } | null) =>
    ipcRenderer.send(IPC.annotationPalette, rect),
  annotationPrint: () => ipcRenderer.invoke(IPC.annotationPrint),
  annotationPaletteToggle: () => ipcRenderer.invoke(IPC.annotationPaletteToggle),
  annotationClose: () => ipcRenderer.invoke(IPC.annotationClose),
  /** AN.6: runs in drawing mode — one-way (no response expected). */
  annotationWheel: (req: AnnotationWheelRequest) => ipcRenderer.send(IPC.annotationWheel, req),
});
