/**
 * main↔renderer IPC contract — typed and versioned.
 *
 * Rules:
 * - Channels always via this file's constants (no loose strings on either side).
 * - Payloads are pure (serializable) interfaces — no functions/classes.
 * - Every change here must be mirrored in src/preload/index.ts and tested
 *   in tests/ipc-contract.test.ts.
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
  /** Renderer asks for the initial state (called on App mount). */
  getBootstrap: "app:get-bootstrap",

  // ── capture sources (M1) ───────────────────────────────────
  listSources: "capture:list-sources",

  // ── region selection (M1) ───────────────────────────────────
  selectRegion: "capture:select-region",

  // ── recording (M1) ────────────────────────────────────────
  startRecording: "capture:start-recording",
  stopRecording: "capture:stop-recording",
  cancelRecording: "capture:cancel-recording",
  addMarker: "capture:add-marker",
  pause: "capture:pause",
  getState: "capture:get-state",

  // ── main→renderers events (M1) ──────────────────────────────
  /** State/waveform/preview events broadcast to picker and bar. */
  event: "capture:event",
  /** Recorder → main: mic level (0..1) ~10x/s (bar renders the waveform). */
  micLevel: "capture:mic-level",
  /** Recorder → main: delivers the blob at the end (unique channel per session via query). */
  blob: "recorder:blob", // prefix — the real channel is `recorder:blob:<startedAt>`

  // ── library and post-production (M2) ───────────────────────────
  listSessions: "library:list",
  getSession: "library:get",
  updateSession: "library:update-meta",
  deleteSession: "library:delete",
  transcribeSession: "library:transcribe",
  createClip: "library:create-clip",
  captureFrame: "library:capture-frame",
  buildContext: "library:build-context",
  /** Editor phase B: clips existing on disk + combined segment cut. */
  listClips: "library:list-clips",
  exportCut: "library:export-cut",
  copyText: "library:copy",
  openPath: "library:open-path",
  openEditor: "library:open-editor",
  /** W2a: saves the session's dictation correction (transcript+meta) + dataset. */
  saveCorrection: "library:save-correction",
  /** W2a: opens the voice dataset window (replaces the :8700 panel). */
  openCorpus: "library:open-corpus",
  ditadoToggle: "ditado:toggle",
  asrStatus: "library:asr-status",
  /** Transcription model switch: effective state (settings+env). */
  asrHostGet: "asr:host-get",
  /** Transcription model switch: on/off toggle (persists in settings.json). */
  asrHostSet: "asr:host-set",

  // ── voice training dataset (W2a — issue #3) ───────────────
  /** Lists the corpus history (transcriptions) — search + labeled filter. */
  listDatasetItems: "dataset:list-items",
  /** Full detail of a corpus item (words/validation/audio). */
  getDatasetItem: "dataset:get-item",
  /** Direct correction on a corpus item (validation block, tmp+rename). */
  saveDatasetCorrection: "dataset:save-correction",

  // ── agent cockpit (C4 — PLANO-COCKPIT) ────────────────
  /** Renderer → main: enqueues a goal in the cockpit worker (typed input). */
  agentRunGoal: "agent:run-goal",
  /** Renderer → main: snapshot of the current goal state (or null). */
  agentGetState: "agent:get-state",

  // ── on-screen annotations (AN.1/AN.2 — PLANO-ANOTACOES-TELA) ─────
  /** Overlay → main: annotation event (main assigns seq/t, persists and returns it). */
  annotationEvent: "annotation:event",
  /** Main → overlay: commands (tool, pass-through mode, capture for composite). */
  annotationCmd: "annotation:cmd",
  /** Overlay → main: burned-in PNG resulting from a capture (b64). */
  annotationComposite: "annotation:composite",
  /** Overlay → main: window mouse control (palette hover / ESC / entering draw mode). */
  annotationMouse: "annotation:mouse",
  /** Overlay → main (sync): active strokes/lasers to compose the screenshot. */
  annotationContext: "annotation:context",
  /** Overlay → main: palette CSS rect (for cursor polling in main). */
  annotationPalette: "annotation:palette",
  /** Overlay → main: manual screenshot (same path as Ctrl+Alt+P). */
  annotationPrint: "annotation:print",
  /** Overlay → main: toggles palette visible/hidden (button ↔ Ctrl+Alt+H). */
  annotationPaletteToggle: "annotation:palette-toggle",
  /** Standalone overlay → main: closes the panel (discards the draft). */
  annotationClose: "annotation:close",
  /** Overlay → main: mouse wheel in draw mode (main forwards to the window below — AN.6). */
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
  /** Global shortcuts registered by main (to display in the UI). */
  shortcuts: { recordFullscreen: string; togglePanel: string };
}

// ── capture sources ──────────────────────────────────────────

export type SourceKind = "screen" | "window";

/** Region selection result: rect in PHYSICAL px of the chosen display. */
export interface RegionSelection {
  rect: Rect;
  displayIndex: number;
}

export interface SourceInfo {
  id: string;
  kind: SourceKind;
  name: string;
  /** PNG dataURL of the thumbnail. */
  thumb: string;
  /** Windows only: bounds in physical px (0 when unavailable). */
  bounds?: { x: number; y: number; width: number; height: number };
}

// ── recording ───────────────────────────────────────────────────

export type RecordingMode = "screen" | "window" | "region";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StartRecordingRequest {
  mode: RecordingMode;
  /** screen/window: desktopCapturer's sourceId. */
  sourceId?: string;
  /** region: rect in PHYSICAL px of the source display. */
  rect?: Rect;
  /** source display of the region (for bounds/coordinates). */
  displayIndex?: number;
  withMic: boolean;
}

export interface RecordingState {
  phase: "idle" | "recording" | "processing";
  mode: RecordingMode | null;
  startedAt: number | null;
  paused: boolean;
  markers: number[];
  /** True between the start request and the capture opening (bar shows "preparing…"). */
  arming?: boolean;
  /** Name of the last finished session (picker opens the editor on it — M2). */
  lastSession?: { dir: string; name: string };
  error?: string;
}

// ── broadcast events (main → picker/bar) ────────────────────

export type CaptureEvent =
  | { type: "state"; state: RecordingState }
  | { type: "mic-level"; level: number } // 0..1
  | { type: "preview"; dataUrl: string } // periodic thumbnail during REC
  | { type: "session-done"; dir: string; name: string; mp4: string }
  | { type: "session-error"; message: string }
  /** Library changed (dictation saved, title edited…) — panel reloads the list. */
  | { type: "sessions-changed" }
  | {
      type: "ditado-state";
      phase: "recording" | "transcribing" | "done";
      /** Jev judgment outcome (only on the "done" phase) */
      rota?: string;
      conf?: number;
      colado?: boolean;
      /** done: ASR was off/down — audio SAVED to the library, transcription pending */
      pendente?: boolean;
      /** transcribing: ASR model still loading (cold start after boot) */
      asrLoading?: boolean;
      /** service estimate to finish loading (s) */
      expectedLoadS?: number;
    }
  /** C4: cockpit goal transition (worker → bridge → broadcast). */
  | { type: "agent-state"; state: GoalState };

// ── on-screen annotations (AN) ─────────────────────────────────────────────────

/** Overlay → main: event creation (main assigns seq/t/ids, persists, returns). */
export type AnnotationEventRequest =
  | { kind: "stroke"; color: string; width: number; points: Pt[] }
  | { kind: "laser"; points: Pt[] }
  | { kind: "erase-stroke"; snapshots: StrokeSnapshot[] }
  /** piece ids (added) are assigned in main (`<seq>.<i>`) */
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
  /** main captured the frame (dataURL) — overlay composes strokes/laser and returns the PNG */
  | { type: "capture"; id: string; frame: string; label: string }
  /** event recorded directly in main (e.g. clear via Ctrl+Alt+C/X) — the overlay
   *  replicates it in its local fold (without this, canvas and main desync). */
  | { type: "sync"; ev: AnnotationEvent };

/**
 * Overlay → main: mouse wheel in draw mode (AN.6). cx/cy are PHYSICAL px
 * inside the overlay (client × dpr, like the stroke points); the rest is the
 * raw DOM WheelEvent for main to map into WM_MOUSEWHEEL (shared/wheel).
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

/** Complete vcInternal (each internal page uses what it needs — a single type,
 *  declared ONCE here, otherwise each renderer's `declare global` collide). */
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
  /** AN.6: wheel in draw mode (fire-and-forget — main injects WM_MOUSEWHEEL into the window below). */
  annotationWheel: (req: AnnotationWheelRequest) => void;
}

/** Surface exposed to the renderer via contextBridge (window.voicecast). */
export interface VoicecastBridge {
  ping(req: PingRequest): Promise<PingResponse>;
  getBootstrap(): Promise<Bootstrap>;
  listSources(kind: SourceKind): Promise<SourceInfo[]>;
  /** Overlays on all displays; drag+release confirms. */
  selectRegion(): Promise<RegionSelection | null>;
  startRecording(req: StartRecordingRequest): Promise<{ ok: boolean; error?: string }>;
  stopRecording(): Promise<{ ok: boolean; error?: string }>;
  cancelRecording(): Promise<{ ok: boolean }>;
  addMarker(): Promise<{ ok: boolean }>;
  pause(paused: boolean): Promise<{ ok: boolean }>;
  getState(): Promise<RecordingState>;
  /** Subscribes to broadcast events (returns unsubscribe). */
  onEvent(cb: (e: CaptureEvent) => void): () => void;

  // M2 — library and post-production
  listSessions(query?: string): Promise<SessionSummary[]>;
  getSession(dir: string, name: string): Promise<SessionDetail | null>;
  updateSession(dir: string, name: string, patch: SessionMetaPatch): Promise<OpResult>;
  deleteSession(dir: string, name: string): Promise<OpResult>;
  transcribeSession(dir: string, name: string): Promise<OpResult>;
  createClip(dir: string, name: string, inS: number, outS: number, label?: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>;
  captureFrame(dir: string, name: string, atS: number): Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  buildContext(dir: string, name: string, range?: { inS: number; outS: number } | null): Promise<{ ok: true; markdown: string } | { ok: false; error: string }>;
  /** .mp4 clips existing in clips/ (name, size, mtime — for the editor list). */
  listClips(dir: string, name: string): Promise<ClipInfo[]>;
  /** Cuts each segment and concatenates into a single mp4 (clips/<label>-<N>seg.mp4). */
  exportCut(dir: string, name: string, segments: SessionSegment[], label?: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>;
  copyText(text: string): Promise<OpResult>;
  openPath(winPath: string): Promise<OpResult>;
  /** Opens the session's editor in its own window. */
  openEditor(dir: string, name: string): Promise<OpResult>;
  /** Saves the session's dictation correction (transcript+meta; dataset via datasetId). */
  saveCorrection(dir: string, name: string, req: SaveCorrectionRequest): Promise<CorrectionResult>;
  /** Opens the voice dataset window (list; optional id opens the detail). */
  openCorpus(id?: string): Promise<OpResult>;
  /** Toggles the dictation (used by the dictation bar). */
  ditadoToggle(): Promise<{ ok: boolean; error?: string }>;
  asrStatus(): Promise<{ ok: boolean; source?: string }>;
  /** Effective state of the transcription model switch (settings+env+host). */
  asrHostGet(): Promise<AsrHostStatus>;
  /** Toggles the transcription model (persists; turning off tears down the service). */
  asrHostSet(enabled: boolean): Promise<{ ok: true; status: AsrHostStatus } | { ok: false; error: string }>;

  // W2a — voice training dataset (replaces the :8700 panel)
  listDatasetItems(query?: string, labeled?: DatasetLabeledFilter): Promise<DatasetItemSummary[]>;
  getDatasetItem(id: string): Promise<DatasetItemDetail | null>;
  saveDatasetCorrection(id: string, req: SaveCorrectionRequest): Promise<CorrectionResult>;

  // C4 — agent cockpit
  /** Enqueues a goal in the cockpit worker (immediate return; states via onEvent "agent-state"). */
  agentRunGoal(goal: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Current goal state (or null if there never was one) — initial snapshot for the bar/panel. */
  agentGetState(): Promise<GoalState | null>;
}

// ── transcription model switch (local ASR) ────────────────

/** ASR host state — what the panel shows on the switch. */
export interface AsrHostStatus {
  /** Effective switch: false = local model doesn't start (env overrides settings). */
  enabled: boolean;
  /** Where the effective state came from: env (VOICECAST_ASR_HOST=0), settings.json or default. */
  source: "env" | "settings" | "default";
  /** Configured external endpoint (VOICECAST_ASR_URLS/VOICE_ASR_URLS) — the host isn't ours. */
  external: boolean;
  /** Our service child process is up right now. */
  hosted: boolean;
}

// ── library / post-production (M2) ─────────────────────────────

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
  /** Thumbnail dataURL (loaded by main). */
  thumb?: string | null;
  markers: number[];
  /** First words of the transcript (card subtitle). */
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
    /** Named segments from the editor (phase B) — clips and context are born from these. */
    segments?: SessionSegment[];
    /** W2a: optional link to the matching item in the voice corpus. */
    datasetId?: string;
    /** W2a: last recorded correction (presence = session already corrected). */
    correction?: { correctedAt: string; nEdits: number; dataset?: string };
  };
  transcript: TranscriptInfo | null;
  /** file:// URL of the media for the editor player. */
  mediaUrl: string | null;
  mediaKind: "video" | "audio" | null;
}

/** Meta patch the renderer may write (everything sanitized in main). */
export interface SessionMetaPatch {
  title?: string;
  tags?: string[];
  segments?: SessionSegment[];
}

/** .mp4 clip existing in clips/ (editor listing — phase B). */
export interface ClipInfo {
  /** Full Windows path. */
  file: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

export type OpResult = { ok: true } | { ok: false; error: string };

// ── dictation correction + voice dataset (W2a — issues #3+#5) ──

/** Word-by-word edit (same shape as the :8700 panel / corrections.py). */
export interface CorrectionEdit {
  /** position in the token stream (index into words). */
  index: number;
  originalW: string;
  correctedW: string;
}

/** `validation` block written into the corpus JSON — the schema IS the corpus (voice). */
export interface ValidationBlock {
  corrected_text: string;
  ts: string;
  n_edits: number;
  edits: CorrectionEdit[];
  labeled_by: string;
}

export interface SaveCorrectionRequest {
  /** Final corrected text (authoritative when words is empty — pure text). */
  correctedText: string;
  /** Word-by-word edits (empty = text-only correction). */
  edits: CorrectionEdit[];
}

/** Where the correction was written (voicecast_corrections_total{alvo} counter). */
export type CorrectionAlvo = "voicecast" | "dataset" | "ambos";

/** Outcome of the write into the voice corpus. */
export type DatasetWriteStatus = "ok" | "ausente" | "erro";

export type CorrectionResult =
  | { ok: true; alvo: CorrectionAlvo; dataset: DatasetWriteStatus }
  | { ok: false; error: string };

export type DatasetLabeledFilter = "any" | "0" | "1";

/** Corpus history item (correction screen list). */
export interface DatasetItemSummary {
  id: string;
  ts: string | null;
  /** First words of the raw ASR text. */
  preview: string;
  durationS: number | null;
  source: string | null;
  language: string | null;
  /** Already has a validation block (labeled correction). */
  validated: boolean;
}

/** Full detail of a corpus item (words + validation + audio). */
export interface DatasetItemDetail {
  id: string;
  ts: string | null;
  /** RAW ASR text — never changed by the correction. */
  text: string;
  durationS: number | null;
  source: string | null;
  language: string | null;
  model: string | null;
  words: { w: string; start: number; end: number; p: number }[];
  validation: ValidationBlock | null;
  /** file:// URL of the wav in raw/ (when it exists). */
  audioUrl: string | null;
}
