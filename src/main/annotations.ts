/**
 * On-screen annotations — main engine (PLANO-ANOTACOES-TELA: AN.1/AN.2, D4–D7).
 *
 * Responsibilities:
 *  - `annotations.jsonl` log as the source of truth (pure engine in
 *    shared/annotations.ts; this file only orchestrates).
 *  - Transparent fullscreen overlay window (sibling of the region overlay): draw
 *    mode (overlay mouse+keyboard) vs pass-through (ignoreMouseEvents +
 *    focusable false — user interacts with the app below).
 *  - Global hotkeys Ctrl+Alt+L/B/E/C/Space/P while active. Ctrl+Z is NOT
 *    global (it would steal the undo of the app below): overlay keyboard in draw
 *    mode + palette buttons.
 *  - Auto-shot of transcription-only mode (D7): stroke/laser burst in the
 *    dictation → 2s debounce → frame + burned-in markers via composite
 *    (ping-pong with the overlay) → frames/print-<t>s.png.
 *  - Dictation has no session dir until stop → log and shots stay buffered
 *    and are saved on detach (persistDeferred).
 */
import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logError, logInfo } from "./logging";
import type { SessionDirs } from "./storage";
import { counter } from "./telemetry";
import { dist, wireLogging } from "./windows";
import { forwardWheelNative, hwndFromWindow, windowExStyle } from "./native-wheel";
import {
  osWheelDelta,
  packWheelLParam,
  packWheelWParam,
  screenPointFromOverlay,
} from "../shared/wheel";
import {
  applyEvent,
  emptyState,
  type AnnotationEvent,
  type AnnotationState,
  type AnnotationTool,
  type EraserMode,
  type Pt,
  type StrokeSnapshot,
} from "../shared/annotations";
import { IPC, type AnnotationCmd, type AnnotationEventRequest, type AnnotationWheelRequest } from "../shared/ipc";

const M_EVENTS = counter("voicecast_annotation_events_total", "annotation events by type");
const M_PRINTS = counter("voicecast_annotation_prints_total", "burned-in shots by kind");

const AUTO_PRINT_DEBOUNCE_MS = 2000;
const LASER_RECENT_MS = 1500; // recent lasers go into the burned-in shot
const HOTKEYS = ["Control+Alt+G", "Control+Alt+B", "Control+Alt+E", "Control+Alt+C", "Control+Alt+X", "Control+Alt+Space", "Control+Alt+P"];

/**
 * The overlay (fullscreen, always-on-top) only comes up where pass-through is
 * reliable. On Linux/Wayland setIgnoreMouseEvents doesn't apply the input
 * region in a stable way (electron#51808 — XWayland/KWin): the overlay in
 * "pass-through" SWALLOWS every click on screen during dictation/REC.
 * VOICECAST_ANNOTATION_OVERLAY=1 forces it (testing, e.g. with ozone=wayland).
 */
function overlaySuportada(): boolean {
  return process.platform === "win32" || process.env.VOICECAST_ANNOTATION_OVERLAY === "1";
}

/** Annotations engine — one instance per process (current session). */
class AnnotationEngine {
  events: AnnotationEvent[] = [];
  state: AnnotationState = emptyState();
  private seq = 0;
  private startedAt = 0;
  private kind: "session" | "ditado" = "session";
  private dirs: SessionDirs | null = null;
  private overlay: BrowserWindow | null = null;
  private drawMode = false;
  private tool: AnnotationTool = "brush";
  private eraserMode: EraserMode = "stroke";
  private autoPrintTimer: NodeJS.Timeout | null = null;
  private pendingComposites = new Map<string, (b64: string | null) => void>();
  /** Dictation: shots generated before the dir exists. */
  private bufferedPrints: { name: string; b64: string }[] = [];
  /** Recent lasers to burn into the shot (ephemeral visual, short memory). */
  private recentLasers: { at: number; points: Pt[] }[] = [];
  /** Palette rect (CSS px) for cursor polling — hover without forward. */
  private paletteBounds: { x: number; y: number; w: number; h: number } | null = null;
  private cursorPoll: NodeJS.Timeout | null = null;
  private mouseOnWindow = false;
  /** Ongoing palette drag: freezes the poll and keeps the window mouse. */
  private dragging = false;
  /** Palette visible (maintainer 2026-09-22: hide without ending the session). */
  private paletteOn = true;
  /** Panel opened outside a session (Ctrl+Alt+H) — draft adoptable by REC. */
  private standalone = false;
  private hotkeysOn = false;

  get active(): boolean {
    return this.overlay !== null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────

  attach(kind: "session" | "ditado", startedAt: number, dirs: SessionDirs | null, opts: { paletteOn?: boolean } = {}): void {
    if (this.overlay) void this.detach();
    this.kind = kind;
    this.startedAt = startedAt;
    this.dirs = dirs;
    this.events = [];
    this.state = emptyState();
    this.seq = 0;
    this.bufferedPrints = [];
    this.recentLasers = [];
    // the palette bounds are from the PREVIOUS overlay — without the reset, the cursor
    // poll would enable the new overlay's mouse over a rect that no longer exists
    this.paletteBounds = null;
    // palette on demand (Ctrl+Alt+H) — maintainer decision (2026-09-23):
    // don't open it together with the recording; the overlay stays alive (shots/hotkeys ok)
    this.paletteOn = opts.paletteOn ?? false;
    this.standalone = false;
    if (!overlaySuportada()) {
      // no overlay (and no hotkeys/poll): the annotations log stays empty and the
      // detach at stop just writes nothing — dictation/REC keep working normally
      logInfo("annotations: overlay off on this OS (pass-through unreliable on Wayland)");
      return;
    }
    this.createOverlay();
    this.registerHotkeys();
    this.sendMode();
    logInfo(`annotations: attach (${kind}${dirs ? "" : ", dir at stop"}${this.paletteOn ? ", palette" : ""})`);
  }

  /**
   * Session/dictation starts: if the standalone panel is already open, it is ADOPTED
   * (overlay and events preserved — pre-REC strokes go into the jsonl; t keeps
   * counting from the panel opening, no negatives). Otherwise, a new attach.
   */
  beginSession(kind: "session" | "ditado", startedAt: number): void {
    if (this.overlay && this.standalone) {
      this.standalone = false;
      this.kind = kind;
      this.dirs = null;
      this.sendMode();
      logInfo(`annotations: standalone panel adopted by the session (${kind})`);
      return;
    }
    this.attach(kind, startedAt, null);
  }

  /** Standalone state → overlay (separate method: avoids TS narrowing). */
  private sendMode(): void {
    this.overlay?.webContents.send(IPC.annotationCmd, { type: "mode", standalone: this.standalone } satisfies AnnotationCmd);
  }

  /** Standalone panel (outside a session) — Ctrl+Alt+H without an active overlay. */
  open(): void {
    if (this.overlay) {
      this.togglePalette();
      return;
    }
    if (!overlaySuportada()) {
      logInfo("annotations: standalone panel unavailable on this OS (overlay off)");
      return;
    }
    this.standalone = true;
    this.kind = "session";
    this.startedAt = Date.now();
    this.dirs = null;
    this.events = [];
    this.state = emptyState();
    this.seq = 0;
    this.bufferedPrints = [];
    this.recentLasers = [];
    this.paletteOn = true;
    this.createOverlay();
    this.registerHotkeys();
    this.sendMode();
    logInfo("annotations: standalone panel opened (Ctrl+Alt+H)");
  }

  /** Standalone palette ✕: closes and discards the draft. */
  closeStandalone(): void {
    if (this.overlay && this.standalone) void this.detach();
  }

  /** Ctrl+Alt+H — app-global: without a panel it opens; with a panel it toggles the palette. */
  onPaletteHotkey(): void {
    if (!this.overlay) {
      this.open();
      return;
    }
    this.togglePalette();
  }

  /** Ends the annotation session. dirs = in dictation, the dir created at stop. */
  async detach(dirs?: SessionDirs | null): Promise<void> {
    if (dirs) this.dirs = dirs;
    // flush the pending burst BEFORE destroying the overlay (composite uses it)
    if (this.autoPrintTimer) {
      clearTimeout(this.autoPrintTimer);
      this.autoPrintTimer = null;
      await this.fireAutoPrint();
    }
    for (const a of HOTKEYS) {
      if (this.hotkeysOn) globalShortcut.unregister(a);
    }
    this.hotkeysOn = false;
    this.stopCursorPoll();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.overlay = null;
    this.mouseOnWindow = false;
    this.dragging = false;
    if (this.dirs) {
      this.flushJsonl();
      this.flushBufferedPrints();
    }
    logInfo(`annotations: detach (${this.events.length} events)`);
  }

  private flushBufferedPrints(): void {
    const dirs = this.dirs;
    if (!dirs || !this.bufferedPrints.length) return;
    try {
      fs.mkdirSync(dirs.frames, { recursive: true });
      for (const p of this.bufferedPrints) {
        fs.writeFileSync(path.join(dirs.frames, p.name), Buffer.from(p.b64, "base64"));
      }
      logInfo(`annotations: ${this.bufferedPrints.length} buffered shots saved`);
      this.bufferedPrints = [];
    } catch (e) {
      logError("annotations: failed to save buffered shots:", e);
    }
  }

  /** Dictation: persists log+buffer once the dir comes to exist (at stop). */
  private flushJsonl(): void {
    if (!this.dirs || !this.events.length) return;
    try {
      fs.mkdirSync(this.dirs.root, { recursive: true });
      const file = path.join(this.dirs.root, "annotations.jsonl");
      for (const ev of this.events) fs.appendFileSync(file, JSON.stringify(ev) + "\n");
      logInfo(`annotations: log persisted (${this.events.length} events)`);
    } catch (e) {
      logError("annotations: failed to persist annotations.jsonl:", e);
    }
  }

  // ── overlay ─────────────────────────────────────────────────────────

  private createOverlay(): void {
    const { BrowserWindow: BW } = require("electron") as typeof import("electron");
    const d = screen.getPrimaryDisplay();
    const w = new BW({
      ...d.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      // not focusable SINCE mapping: if born focusable, KWin may hand it
      // focus at map time (race with the pass-through setFocusable) and the
      // dictation Ctrl+V would land on the overlay instead of the user's window
      focusable: false,
      enableLargerThanScreen: true,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    w.setAlwaysOnTop(true, "screen-saver");
    void w.loadFile(dist("annotation.html"), { query: { dpr: String(d.scaleFactor) } });
    w.once("ready-to-show", () => {
      w.showInactive();
      this.setPassThrough(true);
      // renderer is born with the palette visible — syncs the real state
      // (hidden in a session; standalone/show-up opens with it)
      this.setPaletteVisible(this.paletteOn);
    });
    wireLogging(w, "annotation");
    this.overlay = w;
    this.startCursorPoll();
  }

  /**
   * Palette hover without relying on forwarded mousemove (it didn't reach the
   * renderer on this machine): main polls the cursor and enables the
   * window mouse when the cursor is over the palette (pass-through mode only).
   */
  private startCursorPoll(): void {
    if (this.cursorPoll) clearInterval(this.cursorPoll);
    this.cursorPoll = setInterval(() => {
      const w = this.overlay;
      if (!w || w.isDestroyed() || this.drawMode || this.dragging) return;
      try {
        const c = screen.getCursorScreenPoint();
        const b = w.getBounds();
        const p = this.paletteBounds;
        const inside =
          p !== null &&
          c.x >= b.x + p.x && c.x <= b.x + p.x + p.w &&
          c.y >= b.y + p.y && c.y <= b.y + p.y + p.h;
        if (inside !== this.mouseOnWindow) {
          this.mouseOnWindow = inside;
          logInfo(`annotations: cursor poll → window mouse ${inside ? "ON" : "off"}`);
          w.setIgnoreMouseEvents(!inside, { forward: true });
        }
      } catch {}
    }, 100);
  }

  private stopCursorPoll(): void {
    if (this.cursorPoll) {
      clearInterval(this.cursorPoll);
      this.cursorPoll = null;
    }
  }

  setPaletteBounds(rect: { x: number; y: number; w: number; h: number } | null): void {
    this.paletteBounds = rect;
  }

  /** Mode: draw (mouse+keyboard) or pass-through (user in the app below). */
  setPassThrough(passThrough: boolean): void {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    this.drawMode = !passThrough;
    this.mouseOnWindow = !passThrough; // poll doesn't fight with setPassThrough
    logInfo(`annotations: mode ${passThrough ? "pass-through" : "draw"}`);
    w.setIgnoreMouseEvents(passThrough, { forward: true });
    w.setFocusable(!passThrough);
    if (!passThrough) w.focus();
    // hint for the "freeze": exstyle per mode (LAYERED dropped in draw mode
    // may make apps below be treated as occluded)
    const ex = process.platform === "win32" ? windowExStyle(w) : null;
    logInfo(`annotations: exstyle=0x${ex === null ? "?" : ex.toString(16)} (${passThrough ? "pass-through" : "draw"})`);
    const cmd: AnnotationCmd = { type: "pass-through", on: passThrough };
    w.webContents.send(IPC.annotationCmd, cmd);
  }

  private cmdTool(tool: AnnotationTool): void {
    this.tool = tool;
    if (!this.drawMode) this.setPassThrough(false);
    const cmd: AnnotationCmd = { type: "tool", tool, eraserMode: this.eraserMode };
    this.overlay?.webContents.send(IPC.annotationCmd, cmd);
  }

  /** Palette hover: temporary window mouse (pass-through only). */
  setWindowMouse(mouse: boolean): void {
    const w = this.overlay;
    if (w && !w.isDestroyed() && !this.drawMode) {
      w.setIgnoreMouseEvents(!mouse, { forward: true });
    }
  }

  /** Palette drag (pass-through): window mouse locked ON until released. */
  setPaletteDragging(dragging: boolean): void {
    const w = this.overlay;
    if (!w || w.isDestroyed() || this.drawMode) return;
    this.dragging = dragging;
    this.mouseOnWindow = dragging; // poll doesn't fight mid-drag
    w.setIgnoreMouseEvents(!dragging, { forward: true });
  }

  /** Enter draw mode via the PALETTE (no hotkey) — activates the tool. */
  enterDrawMode(tool?: AnnotationTool): void {
    this.cmdTool(tool ?? this.tool);
  }

  /**
   * AN.6 — mouse wheel in draw mode: injects WM_MOUSEWHEEL into the window
   * UNDER the cursor (the overlay swallows the wheel and Electron doesn't pass it through).
   * Active throughout draw mode (any tool); in pass-through the wheel
   * already belongs to the app below (window outside the hit-test) — nothing to do here.
   */
  forwardWheel(req: AnnotationWheelRequest): void {
    const w = this.overlay;
    if (!w || w.isDestroyed() || !this.drawMode || process.platform !== "win32") return;
    const hwnd = hwndFromWindow(w);
    if (hwnd === null) return;
    const b = w.getContentBounds();
    const sf = screen.getDisplayMatching(b).scaleFactor;
    const pt = screenPointFromOverlay(b, sf, req.cx, req.cy);
    const orig = screenPointFromOverlay(b, sf, 0, 0); // physical position to restore
    const wparam = packWheelWParam({
      delta: osWheelDelta(req),
      ctrl: req.ctrl,
      shift: req.shift,
      buttons: req.buttons,
    });
    forwardWheelNative(hwnd, pt.x, pt.y, orig.x, orig.y, wparam, packWheelLParam(pt.x, pt.y));
  }

  private registerHotkeys(): void {
    if (this.hotkeysOn) return; // adopted standalone panel: already registered
    this.hotkeysOn = true;
    const reg = (accel: string, fn: () => void) => {
      if (!globalShortcut.register(accel, fn)) logError(`annotations: hotkey ${accel} unavailable`);
    };
    // laser on G (maintainer decision 2026-09-22: whole cluster on the left
    // half — right hand off the keyboard)
    reg("Control+Alt+G", () => this.cmdTool("laser"));
    reg("Control+Alt+B", () => this.cmdTool("brush"));
    reg("Control+Alt+E", () => this.cmdTool("eraser"));
    reg("Control+Alt+C", () => void this.record({ kind: "clear" }));
    reg("Control+Alt+X", () => void this.record({ kind: "clear" })); // extra shortcut (maintainer request)
    reg("Control+Alt+Space", () => this.setPassThrough(this.drawMode));
    reg("Control+Alt+P", () => void this.captureComposite("manual", false));
    reg("Control+Alt+H", () => this.togglePalette());
  }

  /** Palette visible/hidden — the palette's own button and Ctrl+Alt+H. */
  togglePalette(): void {
    this.setPaletteVisible(!this.paletteOn);
  }

  setPaletteVisible(on: boolean): void {
    this.paletteOn = on;
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    w.webContents.send(IPC.annotationCmd, { type: "palette", on } satisfies AnnotationCmd);
  }

  // ── eventos ─────────────────────────────────────────────────────────

  record(req: AnnotationEventRequest, fromRenderer = false): AnnotationEvent | null {
    if (!this.overlay) return null;
    this.seq += 1;
    const t = +((Date.now() - this.startedAt) / 1000).toFixed(2);
    let ev: AnnotationEvent;
    switch (req.kind) {
      case "stroke":
        ev = { t, seq: this.seq, type: "stroke", id: String(this.seq), color: req.color, width: req.width, points: req.points };
        break;
      case "laser":
        ev = { t, seq: this.seq, type: "laser", points: req.points };
        this.recentLasers.push({ at: Date.now(), points: req.points });
        this.recentLasers = this.recentLasers.filter((l) => Date.now() - l.at < LASER_RECENT_MS);
        break;
      case "erase-stroke":
        ev = { t, seq: this.seq, type: "erase", mode: "stroke", snapshots: req.snapshots };
        break;
      case "erase-area":
        ev = {
          t,
          seq: this.seq,
          type: "erase",
          mode: "area",
          removed: req.removed,
          added: req.added.map((p, i) => ({ ...p, id: `${this.seq}.${i}` })),
        };
        break;
      case "clear":
        ev = { t, seq: this.seq, type: "clear", snapshots: this.state.strokes };
        break;
      case "undo":
      case "redo":
        ev = { t, seq: this.seq, type: req.kind };
        break;
    }
    this.events.push(ev);
    applyEvent(this.state, ev);
    if (this.dirs) this.appendJsonl(ev);
    // An event that did NOT come from the overlay (e.g., clear via Ctrl+Alt+C/X) needs
    // to reach the renderer's fold — without this the canvas keeps drawing what
    // main already cleared, and the next clear goes out with empty snapshots.
    if (!fromRenderer) {
      this.overlay.webContents.send(IPC.annotationCmd, { type: "sync", ev } satisfies AnnotationCmd);
    }
    M_EVENTS?.add(1, { tipo: ev.type });
    // D7: an annotation burst in transcription-only mode schedules a shot
    if (this.kind === "ditado" && (ev.type === "stroke" || ev.type === "laser")) {
      this.scheduleAutoPrint();
    }
    return ev;
  }

  private appendJsonl(ev: AnnotationEvent): void {
    try {
      fs.mkdirSync(this.dirs!.root, { recursive: true });
      fs.appendFileSync(path.join(this.dirs!.root, "annotations.jsonl"), JSON.stringify(ev) + "\n");
    } catch (e) {
      logError("annotations: failed to write annotations.jsonl:", e);
    }
  }

  // ── shots (manual / auto D7 / marker D6) ───────────────────────────

  private scheduleAutoPrint(): void {
    if (this.autoPrintTimer) clearTimeout(this.autoPrintTimer);
    this.autoPrintTimer = setTimeout(() => {
      this.autoPrintTimer = null;
      void this.fireAutoPrint();
    }, AUTO_PRINT_DEBOUNCE_MS);
    this.autoPrintTimer.unref?.();
  }

  private async fireAutoPrint(): Promise<void> {
    if (await this.captureComposite("auto", true)) M_PRINTS?.add(1, { kind: "auto" });
  }

  /** Marker (D6): frame + burned-in markers. Call from capture.addMarker. */
  async marker(n: number): Promise<void> {
    if (await this.captureComposite("marker", true, `marker-${n}`)) {
      M_PRINTS?.add(1, { kind: "marker" });
    }
  }

  /**
   * Captures the display frame, asks the overlay for the composite (recent
   * strokes/lasers on top) and saves it in frames/. kind=manual doesn't burn strokes.
   */
  private async captureComposite(
    kind: "auto" | "manual" | "marker",
    withStrokes: boolean,
    label?: string,
  ): Promise<boolean> {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return false;
    try {
      const d = screen.getPrimaryDisplay().bounds;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: d.width, height: d.height },
      });
      const src = sources[0];
      if (!src) {
        logError("annotations: no screen source for the shot");
        return false;
      }
      const t = +((Date.now() - this.startedAt) / 1000).toFixed(1);
      const name = `${label ?? `print-${String(t).replace(".", "_")}s`}.png`;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const b64 = await new Promise<string | null>((resolve) => {
        this.pendingComposites.set(id, resolve);
        w.webContents.send(IPC.annotationCmd, {
          type: "capture",
          id,
          frame: src.thumbnail.toDataURL(),
          label: name,
        } satisfies AnnotationCmd);
        setTimeout(() => {
          if (this.pendingComposites.delete(id)) resolve(null);
        }, 4000).unref?.();
      });
      if (!b64) {
        logError("annotations: composite didn't return (timeout)");
        return false;
      }
      this.seq += 1;
      const ev: AnnotationEvent = {
        t: +((Date.now() - this.startedAt) / 1000).toFixed(2),
        seq: this.seq,
        type: "print",
        kind,
        file: `frames/${name}`,
        strokes: withStrokes ? this.state.strokes.map((s) => s.id) : [],
      };
      this.events.push(ev);
      M_EVENTS?.add(1, { tipo: "print" });
      if (this.dirs) {
        fs.mkdirSync(this.dirs.frames, { recursive: true });
        fs.writeFileSync(path.join(this.dirs.frames, name), Buffer.from(b64, "base64"));
        this.appendJsonl(ev);
      } else {
        this.bufferedPrints.push({ name, b64 }); // the dictation log goes out whole at flush
      }
      logInfo(`annotations: shot ${kind} → frames/${name}`);
      return true;
    } catch (e) {
      logError("annotations: captureComposite failed:", e);
      return false;
    }
  }

  /** Context for the overlay to compose the shot (called via IPC by the overlay itself). */
  overlayContext(): { strokes: StrokeSnapshot[]; lasers: { at: number; points: Pt[] }[] } {
    return { strokes: this.state.strokes, lasers: this.recentLasers };
  }

  resolveComposite(id: string, b64: string | null): void {
    const r = this.pendingComposites.get(id);
    if (r) {
      this.pendingComposites.delete(id);
      r(b64);
    }
  }

  /** Manual shot from the palette (same path as Ctrl+Alt+P). */
  manualPrint(): void {
    void this.captureComposite("manual", false).then((ok) => {
      if (ok) M_PRINTS?.add(1, { kind: "manual" });
    });
  }
}

// ── singleton + IPC ────────────────────────────────────────────────────────

export const annotations = new AnnotationEngine();

/** The overlay's context has to come via IPC (main is the state's source). */
export function registerAnnotationIpc(): void {
  ipcMain.handle(IPC.annotationEvent, (_e, req: AnnotationEventRequest) => annotations.record(req, true));
  ipcMain.handle(
    IPC.annotationMouse,
    (_e, req: { mouse: boolean; from: "palette" | "esc" | "draw" | "drag"; tool?: AnnotationTool }) => {
      if (req.from === "esc" && !req.mouse) annotations.setPassThrough(true);
      else if (req.from === "drag") annotations.setPaletteDragging(req.mouse);
      else if (req.from === "draw") annotations.enterDrawMode(req.tool);
      else annotations.setWindowMouse(req.mouse);
      return { ok: true };
    },
  );
  ipcMain.on(IPC.annotationComposite, (_e, p: { id: string; b64: string | null }) => {
    annotations.resolveComposite(p.id, p.b64);
  });
  /** Overlay asks for the state to compose the shot (active strokes/lasers). */
  ipcMain.on(IPC.annotationContext, (e) => {
    e.returnValue = annotations.overlayContext();
  });
  ipcMain.on(IPC.annotationPalette, (_e, rect: { x: number; y: number; w: number; h: number } | null) => {
    annotations.setPaletteBounds(rect);
  });
  ipcMain.handle(IPC.annotationPrint, () => {
    void annotations.manualPrint();
    return { ok: true };
  });
  ipcMain.handle(IPC.annotationPaletteToggle, () => {
    annotations.togglePalette();
    return { ok: true };
  });
  ipcMain.handle(IPC.annotationClose, () => {
    annotations.closeStandalone();
    return { ok: true };
  });
  /** AN.6: wheel in draw mode → WM_MOUSEWHEEL into the window below (one-way). */
  ipcMain.on(IPC.annotationWheel, (_e, req: AnnotationWheelRequest) => {
    annotations.forwardWheel(req);
  });
}
