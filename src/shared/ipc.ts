/**
 * Contrato IPC main↔renderer — tipado e versionado.
 *
 * Regras:
 * - Canais sempre via constantes deste arquivo (sem string solta nos lados).
 * - Payloads são interfaces puras (serializáveis) — nada de funções/classe.
 * - Toda mudança aqui precisa refletir em src/preload/index.ts e ser testada
 *   em tests/ipc-contract.test.ts.
 */
import type {
  AnnotationEvent,
  AnnotationTool,
  EraserMode,
  Pt,
  StrokeSnapshot,
} from "./annotations";
import type { GoalPhase, GoalState } from "./agent-goal";
import type { SessionSegment } from "./segments";

export type { AnnotationEvent, AnnotationTool, EraserMode, Pt, StrokeSnapshot, SessionSegment, GoalPhase, GoalState };

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
  /** Editor fase B: clipes existentes no disco + corte combinado de segmentos. */
  listClips: "library:list-clips",
  exportCut: "library:export-cut",
  copyText: "library:copy",
  openPath: "library:open-path",
  openEditor: "library:open-editor",
  /** W2a: salva correção de ditado na sessão (transcript+meta) + dataset. */
  saveCorrection: "library:save-correction",
  /** W2a: abre a janela do dataset do voice (substitui o painel :8700). */
  openCorpus: "library:open-corpus",
  ditadoToggle: "ditado:toggle",
  asrStatus: "library:asr-status",

  // ── dataset de treino do voice (W2a — issue #3) ───────────────
  /** Lista o histórico do corpus (transcriptions) — busca + filtro rotuladas. */
  listDatasetItems: "dataset:list-items",
  /** Detalhe completo de um item do corpus (words/validation/áudio). */
  getDatasetItem: "dataset:get-item",
  /** Correção direta num item do corpus (bloco validation, tmp+rename). */
  saveDatasetCorrection: "dataset:save-correction",

  // ── cockpit de agente (C4 — PLANO-COCKPIT) ────────────────────
  /** Renderer → main: enfileira um goal no worker do cockpit (entrada digitada). */
  agentRunGoal: "agent:run-goal",
  /** Renderer → main: snapshot do estado atual do goal (ou null). */
  agentGetState: "agent:get-state",

  // ── anotações em tela (AN.1/AN.2 — PLANO-ANOTACOES-TELA) ─────
  /** Overlay → main: evento de anotação (main atribui seq/t, persiste e devolve). */
  annotationEvent: "annotation:event",
  /** Main → overlay: comandos (tool, modo pass-through, captura p/ composite). */
  annotationCmd: "annotation:cmd",
  /** Overlay → main: PNG queimado resultante de uma captura (b64). */
  annotationComposite: "annotation:composite",
  /** Overlay → main: controle de mouse da janela (paleta hover / ESC / entrar no desenho). */
  annotationMouse: "annotation:mouse",
  /** Overlay → main (sync): strokes/lasers ativos p/ compor o print. */
  annotationContext: "annotation:context",
  /** Overlay → main: retângulo CSS da paleta (p/ polling de cursor no main). */
  annotationPalette: "annotation:palette",
  /** Overlay → main: print manual (mesmo caminho do Ctrl+Alt+P). */
  annotationPrint: "annotation:print",
  /** Overlay → main: alterna paleta visível/oculta (botão ↔ Ctrl+Alt+H). */
  annotationPaletteToggle: "annotation:palette-toggle",
  /** Overlay standalone → main: fecha o painel (descarta o rascunho). */
  annotationClose: "annotation:close",
  /** Overlay → main: roda do mouse em modo desenho (main repassa à janela de baixo — AN.6). */
  annotationWheel: "annotation:wheel",
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

/** Resultado da seleção de região: retângulo em px FÍSICOS do display escolhido. */
export interface RegionSelection {
  rect: Rect;
  displayIndex: number;
}

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
  /** True entre o pedido de start e a captura aberta (barra mostra "preparando…"). */
  arming?: boolean;
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
  /** Biblioteca mudou (ditado salvo, título editado…) — painel recarrega a lista. */
  | { type: "sessions-changed" }
  | {
      type: "ditado-state";
      phase: "recording" | "transcribing" | "done";
      /** desfecho do julgamento Jev (só no phase "done") */
      rota?: string;
      conf?: number;
      colado?: boolean;
    }
  /** C4: transição do goal do cockpit (worker → bridge → broadcast). */
  | { type: "agent-state"; state: GoalState };

// ── anotações em tela (AN) ─────────────────────────────────────────────────

/** Overlay → main: criação de evento (main atribui seq/t/ids, persiste, devolve). */
export type AnnotationEventRequest =
  | { kind: "stroke"; color: string; width: number; points: Pt[] }
  | { kind: "laser"; points: Pt[] }
  | { kind: "erase-stroke"; snapshots: StrokeSnapshot[] }
  /** ids dos pedaços (added) são atribuídos no main (`<seq>.<i>`) */
  | { kind: "erase-area"; removed: StrokeSnapshot[]; added: Omit<StrokeSnapshot, "id">[] }
  | { kind: "clear" }
  | { kind: "undo" }
  | { kind: "redo" };

/** Main → overlay. */
export type AnnotationCmd =
  | { type: "tool"; tool: AnnotationTool; eraserMode?: EraserMode }
  | { type: "pass-through"; on: boolean }
  | { type: "palette"; on: boolean }
  | { type: "mode"; standalone: boolean }
  /** main capturou o frame (dataURL) — overlay compõe strokes/laser e devolve o PNG */
  | { type: "capture"; id: string; frame: string; label: string }
  /** evento gravado direto no main (ex.: limpar via Ctrl+Alt+C/X) — o overlay
   *  replica no fold local (sem isso, canvas e main desincronizam). */
  | { type: "sync"; ev: AnnotationEvent };

/**
 * Overlay → main: roda do mouse em modo desenho (AN.6). cx/cy são px FÍSICOS
 * dentro do overlay (client × dpr, como os pontos de stroke); o resto é o
 * WheelEvent DOM cru para o main mapear em WM_MOUSEWHEEL (shared/wheel).
 */
export interface AnnotationWheelRequest {
  cx: number;
  cy: number;
  deltaY: number;
  deltaMode: number;
  ctrl: boolean;
  shift: boolean;
  buttons: number;
}

/** vcInternal completo (cada página interna usa o que precisa — um tipo só,
 *  declarado UMA vez aqui, senão os `declare global` de cada renderer colidem). */
export interface VcInternalBridge {
  micLevel: (level: number) => void;
  sendBlob: (ch: string, payload: { b64: string; ext: string }) => void;
  sendRegion: (channel: string, rect: unknown) => void;
  annotationEvent: (req: AnnotationEventRequest) => Promise<AnnotationEvent | null>;
  onAnnotationCmd: (cb: (cmd: AnnotationCmd) => void) => () => void;
  sendComposite: (id: string, b64: string | null) => void;
  annotationMouse: (req: { mouse: boolean; from: "palette" | "esc" | "draw" | "drag"; tool?: AnnotationTool }) => Promise<{ ok: boolean }>;
  annotationContext: () => { strokes: StrokeSnapshot[]; lasers: { at: number; points: Pt[] }[] };
  annotationPaletteBounds: (rect: { x: number; y: number; w: number; h: number } | null) => void;
  annotationPrint: () => Promise<{ ok: boolean }>;
  annotationPaletteToggle: () => Promise<{ ok: boolean }>;
  annotationClose: () => Promise<{ ok: boolean }>;
  /** AN.6: roda no modo desenho (fire-and-forget — main injeta WM_MOUSEWHEEL na janela de baixo). */
  annotationWheel: (req: AnnotationWheelRequest) => void;
}

/** Superfície exposta ao renderer via contextBridge (window.voicecast). */
export interface VoicecastBridge {
  ping(req: PingRequest): Promise<PingResponse>;
  getBootstrap(): Promise<Bootstrap>;
  listSources(kind: SourceKind): Promise<SourceInfo[]>;
  /** Overlays em todos os displays; arrastar+soltar confirma. */
  selectRegion(): Promise<RegionSelection | null>;
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
  updateSession(dir: string, name: string, patch: SessionMetaPatch): Promise<OpResult>;
  deleteSession(dir: string, name: string): Promise<OpResult>;
  transcribeSession(dir: string, name: string): Promise<OpResult>;
  createClip(dir: string, name: string, inS: number, outS: number, label?: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>;
  captureFrame(dir: string, name: string, atS: number): Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  buildContext(dir: string, name: string, range?: { inS: number; outS: number } | null): Promise<{ ok: true; markdown: string } | { ok: false; error: string }>;
  /** Clipes .mp4 que existem em clips/ (nome, tamanho, mtime — p/ lista do editor). */
  listClips(dir: string, name: string): Promise<ClipInfo[]>;
  /** Corta cada segmento e concatena num mp4 único (clips/<label>-<N>seg.mp4). */
  exportCut(dir: string, name: string, segments: SessionSegment[], label?: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>;
  copyText(text: string): Promise<OpResult>;
  openPath(winPath: string): Promise<OpResult>;
  /** Abre o editor da sessão numa janela própria. */
  openEditor(dir: string, name: string): Promise<OpResult>;
  /** Salva a correção do ditado da sessão (transcript+meta; dataset via datasetId). */
  saveCorrection(dir: string, name: string, req: SaveCorrectionRequest): Promise<CorrectionResult>;
  /** Abre a janela do dataset do voice (lista; id opcional abre o detalhe). */
  openCorpus(id?: string): Promise<OpResult>;
  /** Liga/desliga o ditado (usado pela barra do ditado). */
  ditadoToggle(): Promise<{ ok: boolean; error?: string }>;
  asrStatus(): Promise<{ ok: boolean; source?: string }>;

  // W2a — dataset de treino do voice (substitui o painel :8700)
  listDatasetItems(query?: string, labeled?: DatasetLabeledFilter): Promise<DatasetItemSummary[]>;
  getDatasetItem(id: string): Promise<DatasetItemDetail | null>;
  saveDatasetCorrection(id: string, req: SaveCorrectionRequest): Promise<CorrectionResult>;

  // C4 — cockpit de agente
  /** Enfileira um goal no worker do cockpit (retorno imediato; estados via onEvent "agent-state"). */
  agentRunGoal(goal: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Estado atual do goal (ou null se nunca houve) — snapshot inicial da barra/painel. */
  agentGetState(): Promise<GoalState | null>;
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
    /** Trechos nomeados do editor (fase B) — clipe e contexto nascem daqui. */
    segments?: SessionSegment[];
    /** W2a: link opcional com o item correspondente no corpus do voice. */
    datasetId?: string;
    /** W2a: última correção gravada (presença = sessão já corrigida). */
    correction?: { correctedAt: string; nEdits: number; dataset?: string };
  };
  transcript: TranscriptInfo | null;
  /** file:// URL da mídia para o player do editor. */
  mediaUrl: string | null;
  mediaKind: "video" | "audio" | null;
}

/** Patch de meta que o renderer pode gravar (tudo sanitizado no main). */
export interface SessionMetaPatch {
  title?: string;
  tags?: string[];
  segments?: SessionSegment[];
}

/** Clipe .mp4 existente em clips/ (listagem do editor — fase B). */
export interface ClipInfo {
  /** Caminho Windows completo. */
  file: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

export type OpResult = { ok: true } | { ok: false; error: string };

// ── correção de ditados + dataset do voice (W2a — issues #3+#5) ──

/** Marcação palavra a palavra (mesmo shape do painel :8700 / corrections.py). */
export interface CorrectionEdit {
  /** posição no token stream (index em words). */
  index: number;
  originalW: string;
  correctedW: string;
}

/** Bloco `validation` gravado no JSON do corpus — schema É o corpus (voice). */
export interface ValidationBlock {
  corrected_text: string;
  ts: string;
  n_edits: number;
  edits: CorrectionEdit[];
  labeled_by: string;
}

export interface SaveCorrectionRequest {
  /** Texto final corrigido (autorisado quando words vazio — texto puro). */
  correctedText: string;
  /** Edições palavra a palavra (vazio = correção só de texto). */
  edits: CorrectionEdit[];
}

/** Onde a correção foi gravada (counter voicecast_corrections_total{alvo}). */
export type CorrectionAlvo = "voicecast" | "dataset" | "ambos";

/** Desfecho da escrita no corpus do voice. */
export type DatasetWriteStatus = "ok" | "ausente" | "erro";

export type CorrectionResult =
  | { ok: true; alvo: CorrectionAlvo; dataset: DatasetWriteStatus }
  | { ok: false; error: string };

export type DatasetLabeledFilter = "any" | "0" | "1";

/** Item do histórico do corpus (lista da tela de correção). */
export interface DatasetItemSummary {
  id: string;
  ts: string | null;
  /** Primeiras palavras do texto cru do ASR. */
  preview: string;
  durationS: number | null;
  source: string | null;
  language: string | null;
  /** Já tem bloco validation (correção rotulada). */
  validated: boolean;
}

/** Detalhe completo de um item do corpus (words + validation + áudio). */
export interface DatasetItemDetail {
  id: string;
  ts: string | null;
  /** Texto CRU do ASR — nunca é alterado pela correção. */
  text: string;
  durationS: number | null;
  source: string | null;
  language: string | null;
  model: string | null;
  words: { w: string; start: number; end: number; p: number }[];
  validation: ValidationBlock | null;
  /** file:// URL do wav no raw/ (quando existe). */
  audioUrl: string | null;
}
