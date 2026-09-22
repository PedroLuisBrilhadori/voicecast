/**
 * Preload: ponte mínima e tipada para o renderer (contextIsolation on).
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AnnotationCmd,
  type AnnotationEvent,
  type AnnotationEventRequest,
  type Bootstrap,
  type CaptureEvent,
  type PingRequest,
  type PingResponse,
  type RecordingState,
  type SourceInfo,
  type StartRecordingRequest,
  type VoicecastBridge,
} from "../shared/ipc";

const bridge: VoicecastBridge = {
  ping: (req: PingRequest): Promise<PingResponse> => ipcRenderer.invoke(IPC.ping, req),
  getBootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.getBootstrap),
  listSources: (kind: SourceInfo["kind"]): Promise<SourceInfo[]> =>
    ipcRenderer.invoke(IPC.listSources, kind),
  selectRegion: (displayIndex?: number) => ipcRenderer.invoke(IPC.selectRegion, displayIndex),
  startRecording: (req: StartRecordingRequest) => ipcRenderer.invoke(IPC.startRecording, req),
  stopRecording: () => ipcRenderer.invoke(IPC.stopRecording),
  cancelRecording: () => ipcRenderer.invoke(IPC.cancelRecording),
  addMarker: () => ipcRenderer.invoke(IPC.addMarker),
  pause: (paused: boolean) => ipcRenderer.invoke(IPC.pause, paused),
  getState: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.getState),
  listSessions: (query?: string) => ipcRenderer.invoke(IPC.listSessions, query),
  getSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.getSession, dir, name),
  updateSession: (dir: string, name: string, patch: { title?: string; tags?: string[] }) =>
    ipcRenderer.invoke(IPC.updateSession, dir, name, patch),
  deleteSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.deleteSession, dir, name),
  transcribeSession: (dir: string, name: string) => ipcRenderer.invoke(IPC.transcribeSession, dir, name),
  createClip: (dir: string, name: string, inS: number, outS: number, label?: string) =>
    ipcRenderer.invoke(IPC.createClip, dir, name, inS, outS, label),
  captureFrame: (dir: string, name: string, atS: number) =>
    ipcRenderer.invoke(IPC.captureFrame, dir, name, atS),
  buildContext: (dir: string, name: string, range?: { inS: number; outS: number } | null) =>
    ipcRenderer.invoke(IPC.buildContext, dir, name, range),
  copyText: (text: string) => ipcRenderer.invoke(IPC.copyText, text),
  openPath: (winPath: string) => ipcRenderer.invoke(IPC.openPath, winPath),
  openEditor: (dir: string, name: string) => ipcRenderer.invoke(IPC.openEditor, dir, name),
  ditadoToggle: () => ipcRenderer.invoke(IPC.ditadoToggle),
  asrStatus: () => ipcRenderer.invoke(IPC.asrStatus),
  onEvent: (cb: (e: CaptureEvent) => void) => {
    const h = (_e: unknown, ev: CaptureEvent) => cb(ev);
    ipcRenderer.on(IPC.event, h);
    return () => ipcRenderer.removeListener(IPC.event, h);
  },
};

contextBridge.exposeInMainWorld("voicecast", bridge);

/** Extras só para páginas internas de captura (recorder/overlay/barra). */
contextBridge.exposeInMainWorld("vcInternal", {
  /** Nível do mic do recorder (0..1). */
  micLevel: (level: number) => ipcRenderer.send(IPC.micLevel, level),
  /** Entrega do blob no stop — canais restritos aos prefixos de captura. */
  sendBlob: (channel: string, payload: { b64: string; ext: string }) => {
    if (!channel.startsWith("recorder:blob:") && !channel.startsWith("ditado:blob:")) {
      throw new Error("canal não autorizado");
    }
    ipcRenderer.send(channel, payload);
  },
  /** Resultado do overlay de região (canal único por seleção). */
  sendRegion: (channel: string, rect: unknown) => {
    if (!channel.startsWith("region:result:")) throw new Error("canal não autorizado");
    ipcRenderer.send(channel, rect);
  },
  // ── overlay de anotações (AN.1/AN.2) ─────────────────────────
  /** Cria um evento de anotação — main atribui seq/t/ids e devolve o evento. */
  annotationEvent: (req: AnnotationEventRequest): Promise<AnnotationEvent | null> =>
    ipcRenderer.invoke(IPC.annotationEvent, req),
  /** Comandos do main: ferramenta, modo pass-through, captura p/ composite. */
  onAnnotationCmd: (cb: (cmd: AnnotationCmd) => void) => {
    const h = (_e: unknown, cmd: AnnotationCmd) => cb(cmd);
    ipcRenderer.on(IPC.annotationCmd, h);
    return () => ipcRenderer.removeListener(IPC.annotationCmd, h);
  },
  /** PNG queimado (b64) devolvendo uma captura pedida pelo main. */
  sendComposite: (id: string, b64: string) =>
    ipcRenderer.send(IPC.annotationComposite, { id, b64 }),
  /** Mouse da janela: paleta hover (temporário), ESC (sai do desenho) ou entrar no desenho pela paleta. */
  annotationMouse: (req: { mouse: boolean; from: "palette" | "esc" | "draw"; tool?: import("../shared/annotations").AnnotationTool }) =>
    ipcRenderer.invoke(IPC.annotationMouse, req),
  /** Strokes/lasers ativos (sendSync — só no caminho do print). */
  annotationContext: (): {
    strokes: import("../shared/annotations").StrokeSnapshot[];
    lasers: { at: number; points: import("../shared/annotations").Pt[] }[];
  } => ipcRenderer.sendSync(IPC.annotationContext),
  /** Retângulo da paleta (CSS px) — main faz polling do cursor por cima. */
  annotationPaletteBounds: (rect: { x: number; y: number; w: number; h: number }) =>
    ipcRenderer.send(IPC.annotationPalette, rect),
});
