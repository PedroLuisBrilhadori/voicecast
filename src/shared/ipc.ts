/**
 * Contrato IPC main↔renderer — tipado e versionado.
 *
 * Regras:
 * - Canais sempre via constantes deste arquivo (sem string solta nos lados).
 * - Payloads são interfaces puras (serializáveis) — nada de funções/classe.
 * - Toda mudança aqui precisa refletir em src/preload/index.ts e ser testada
 *   em tests/ipc-contract.test.ts.
 */

export const IPC = {
  ping: "app:ping",
  getVersion: "app:get-version",
  /** Renderer pede o estado inicial (chamado no mount do App). */
  getBootstrap: "app:get-bootstrap",
} as const;

export interface PingRequest {
  nonce: number;
}
export interface PingResponse {
  nonce: number;
  at: number;
}

export interface Bootstrap {
  version: string;
  platform: "win32" | "linux" | "darwin";
  /** Atalhos globais registrados pelo main (para exibir na UI). */
  shortcuts: { recordFullscreen: string; togglePanel: string };
}

/** Superfície exposta ao renderer via contextBridge (window.voicecast). */
export interface VoicecastBridge {
  ping(req: PingRequest): Promise<PingResponse>;
  getBootstrap(): Promise<Bootstrap>;
}
