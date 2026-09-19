/**
 * Preload: ponte mínima e tipada para o renderer (contextIsolation on).
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type PingRequest, type PingResponse, type Bootstrap, type VoicecastBridge } from "../shared/ipc";

const bridge: VoicecastBridge = {
  ping: (req: PingRequest): Promise<PingResponse> => ipcRenderer.invoke(IPC.ping, req),
  getBootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.getBootstrap),
};

contextBridge.exposeInMainWorld("voicecast", bridge);
