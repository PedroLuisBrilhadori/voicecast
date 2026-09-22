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

  // ── biblioteca e pós-produção (M2) ───────────────────────────
  listSessions: "library:list",
  getSession: "library:get",
  updateSession: "library:update-meta",
  deleteSession: "library:delete",
  transcribeSession: "library:transcribe",
  createClip: "library:create-clip",
  captureFrame: "library:capture-frame",
  buildContext: "library:build-context",
  copyText: "library:copy",
  openPath: "library:open-path",
  openEditor: "library:open-editor",
  ditadoToggle: "ditado:toggle",
  asrStatus: "library:asr-status",
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
  | { type: "session-error"; message: string }
  | {
      type: "ditado-state";
      phase: "recording" | "transcribing" | "done";
      /** desfecho do julgamento Jev (só no phase "done") */
      rota?: string;
      conf?: number;
      colado?: boolean;
    };

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

  // M2 — biblioteca e pós-produção
  listSessions(query?: string): Promise<SessionSummary[]>;
  getSession(dir: string, name: string): Promise<SessionDetail | null>;
  updateSession(dir: string, name: string, patch: { title?: string; tags?: string[] }): Promise<OpResult>;
  deleteSession(dir: string, name: string): Promise<OpResult>;
  transcribeSession(dir: string, name: string): Promise<OpResult>;
  createClip(dir: string, name: string, inS: number, outS: number, label?: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>;
  captureFrame(dir: string, name: string, atS: number): Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  buildContext(dir: string, name: string, range?: { inS: number; outS: number } | null): Promise<{ ok: true; markdown: string } | { ok: false; error: string }>;
  copyText(text: string): Promise<OpResult>;
  openPath(winPath: string): Promise<OpResult>;
  /** Abre o editor da sessão numa janela própria. */
  openEditor(dir: string, name: string): Promise<OpResult>;
  /** Liga/desliga o ditado (usado pela barra do ditado). */
  ditadoToggle(): Promise<{ ok: boolean; error?: string }>;
  asrStatus(): Promise<{ ok: boolean; source?: string }>;
}

// ── biblioteca / pós-produção (M2) ─────────────────────────────

export interface SessionSummary {
  dir: string;
  name: string;
  status: string;
  startedAt: string | null;
  durationS: number | null;
  mode: string | null;
  sourceLabel: string | null;
  title: string | null;
  tags: string[];
  sizeBytes: number | null;
  hasMp4: boolean;
  hasTranscript: boolean;
  transcriptStatus: string | null;
  /** dataURL do thumbnail (carregado pelo main). */
  thumb?: string | null;
  markers: number[];
  /** Primeiras palavras da transcrição (subtítulo do card). */
  preview?: string | null;
}

export interface TranscriptInfo {
  text: string;
  language: string | null;
  words: { w: string; start: number; end: number; p: number }[];
  segments: { start: number; end: number; text: string }[];
}

export interface SessionDetail {
  dir: string;
  name: string;
  meta: {
    status?: string;
    startedAt?: string;
    durationS?: number;
    mode?: string;
    sourceLabel?: string;
    title?: string;
    tags?: string[];
    markers?: number[];
    transcriptStatus?: string;
    sizeBytes?: number;
  };
  transcript: TranscriptInfo | null;
  /** file:// URL da mídia para o player do editor. */
  mediaUrl: string | null;
  mediaKind: "video" | "audio" | null;
}

export type OpResult = { ok: true } | { ok: false; error: string };
