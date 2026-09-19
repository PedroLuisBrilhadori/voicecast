/**
 * Preload: ponte mínima e tipada para o renderer (contextIsolation on).
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
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
  /** Entrega do blob no stop — canal restrito ao prefixo recorder:. */
  sendBlob: (channel: string, payload: { b64: string; ext: string }) => {
    if (!channel.startsWith("recorder:blob:")) throw new Error("canal não autorizado");
    ipcRenderer.send(channel, payload);
  },
  /** Resultado do overlay de região (canal único por seleção). */
  sendRegion: (channel: string, rect: unknown) => {
    if (!channel.startsWith("region:result:")) throw new Error("canal não autorizado");
    ipcRenderer.send(channel, rect);
  },
});
