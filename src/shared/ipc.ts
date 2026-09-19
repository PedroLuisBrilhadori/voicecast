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

  // ── fontes de captura (M1) ───────────────────────────────────
  listSources: "capture:list-sources",

  // ── seleção de região (M1) ───────────────────────────────────
  selectRegion: "capture:select-region",

  // ── gravação (M1) ────────────────────────────────────────────
  startRecording: "capture:start-recording",
  stopRecording: "capture:stop-recording",
  cancelRecording: "capture:cancel-recording",
  addMarker: "capture:add-marker",
  pause: "capture:pause",
  getState: "capture:get-state",

  // ── eventos main→renderers (M1) ──────────────────────────────
  /** Eventos de estado/waveform/preview broadcast para picker e barra. */
  event: "capture:event",
  /** Recorder → main: nível do mic (0..1) ~10x/s (barra exibe waveform). */
  micLevel: "capture:mic-level",
  /** Recorder → main: entrega o blob no fim (canal único por sessão via query). */
  blob: "recorder:blob", // prefixo — canal real é `recorder:blob:<startedAt>`
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

// ── fontes de captura ──────────────────────────────────────────

export type SourceKind = "screen" | "window";

export interface SourceInfo {
  id: string;
  kind: SourceKind;
  name: string;
  /** dataURL PNG da miniatura. */
  thumb: string;
  /** Só para janelas: bounds em px físicos (0 quando indisponível). */
  bounds?: { x: number; y: number; width: number; height: number };
}

// ── gravação ───────────────────────────────────────────────────

export type RecordingMode = "screen" | "window" | "region";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StartRecordingRequest {
  mode: RecordingMode;
  /** screen/window: sourceId do desktopCapturer. */
  sourceId?: string;
  /** region: retângulo em px FÍSICOS do display de origem. */
  rect?: Rect;
  /** display de origem da região (para_bounds/coordenadas). */
  displayIndex?: number;
  withMic: boolean;
}

export interface RecordingState {
  phase: "idle" | "recording" | "processing";
  mode: RecordingMode | null;
  startedAt: number | null;
  paused: boolean;
  markers: number[];
  /** Nome da última sessão finalizada (picker abre o editor nela — M2). */
  lastSession?: { dir: string; name: string };
  error?: string;
}

// ── eventos broadcast (main → picker/barra) ────────────────────

export type CaptureEvent =
  | { type: "state"; state: RecordingState }
  | { type: "mic-level"; level: number } // 0..1
  | { type: "preview"; dataUrl: string } // miniatura periódica durante REC
  | { type: "session-done"; dir: string; name: string; mp4: string }
  | { type: "session-error"; message: string };

/** Superfície exposta ao renderer via contextBridge (window.voicecast). */
export interface VoicecastBridge {
  ping(req: PingRequest): Promise<PingResponse>;
  getBootstrap(): Promise<Bootstrap>;
  listSources(kind: SourceKind): Promise<SourceInfo[]>;
  selectRegion(displayIndex?: number): Promise<Rect | null>;
  startRecording(req: StartRecordingRequest): Promise<{ ok: boolean; error?: string }>;
  stopRecording(): Promise<{ ok: boolean; error?: string }>;
  cancelRecording(): Promise<{ ok: boolean }>;
  addMarker(): Promise<{ ok: boolean }>;
  pause(paused: boolean): Promise<{ ok: boolean }>;
  getState(): Promise<RecordingState>;
  /** Assina eventos broadcast (retorna unsubscribe). */
  onEvent(cb: (e: CaptureEvent) => void): () => void;
}
