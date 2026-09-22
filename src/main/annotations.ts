/**
 * Anotações em tela — engine do main (PLANO-ANOTACOES-TELA: AN.1/AN.2, D4–D7).
 *
 * Responsabilidades:
 *  - Log `annotations.jsonl` como fonte da verdade (motor puro em
 *    shared/annotations.ts; este arquivo só orquestra).
 *  - Janela overlay fullscreen transparente (irmã do overlay de região): modo
 *    desenho (mouse+teclado da overlay) vs pass-through (ignoreMouseEvents +
 *    focusable false — usuário interage com o app embaixo).
 *  - Hotkeys globais Ctrl+Alt+L/B/E/C/Espaço/P enquanto ativa. Ctrl+Z NÃO é
 *    global (roubaria o undo do app embaixo): teclado da overlay em modo
 *    desenho + botões da paleta.
 *  - Auto-print do modo somente-transcrição (D7): rajada de stroke/laser no
 *    ditado → debounce 2s → frame + marcações queimadas via composite
 *    (ping-pong com o overlay) → frames/print-<t>s.png.
 *  - Ditado não tem dir de sessão até o stop → log e prints ficam em buffer
 *    e são salvos no detach (persistDeferred).
 */
import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logError, logInfo } from "./logging";
import type { SessionDirs } from "./storage";
import { counter } from "./telemetry";
import { dist, wireLogging } from "./windows";
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
import { IPC, type AnnotationCmd, type AnnotationEventRequest } from "../shared/ipc";

const M_EVENTS = counter("voicecast_annotation_events_total", "eventos de anotação por tipo");
const M_PRINTS = counter("voicecast_annotation_prints_total", "prints queimados por kind");

const AUTO_PRINT_DEBOUNCE_MS = 2000;
const LASER_RECENT_MS = 1500; // lasers recentes entram no print queimado
const HOTKEYS = ["Control+Alt+L", "Control+Alt+B", "Control+Alt+E", "Control+Alt+C", "Control+Alt+Space", "Control+Alt+P", "Control+Alt+H"];

/** Engine de anotações — uma instância por processo (sessão corrente). */
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
  /** Ditado: prints gerados antes do dir existir. */
  private bufferedPrints: { name: string; b64: string }[] = [];
  /** Lasers recentes p/ queimar no print (visual efêmero, memória curta). */
  private recentLasers: { at: number; points: Pt[] }[] = [];
  /** Retângulo da paleta (CSS px) p/ polling de cursor — hover sem forward. */
  private paletteBounds: { x: number; y: number; w: number; h: number } | null = null;
  private cursorPoll: NodeJS.Timeout | null = null;
  private mouseOnWindow = false;
  /** Drag da paleta em curso: congela o poll e mantém o mouse da janela. */
  private dragging = false;
  /** Paleta visível (mantenedor 2026-09-22: ocultar sem encerrar a sessão). */
  private paletteOn = true;

  get active(): boolean {
    return this.overlay !== null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────

  attach(kind: "session" | "ditado", startedAt: number, dirs: SessionDirs | null): void {
    if (this.overlay) void this.detach();
    this.kind = kind;
    this.startedAt = startedAt;
    this.dirs = dirs;
    this.events = [];
    this.state = emptyState();
    this.seq = 0;
    this.bufferedPrints = [];
    this.recentLasers = [];
    this.paletteOn = true;
    this.createOverlay();
    this.registerHotkeys();
    logInfo(`anotações: attach (${kind}${dirs ? "" : ", dir no stop"})`);
  }

  /** Para a sessão de anotações. dirs = no ditado, o dir criado no stop. */
  async detach(dirs?: SessionDirs | null): Promise<void> {
    if (dirs) this.dirs = dirs;
    // flush da rajada pendente ANTES de destruir a overlay (composite a usa)
    if (this.autoPrintTimer) {
      clearTimeout(this.autoPrintTimer);
      this.autoPrintTimer = null;
      await this.fireAutoPrint();
    }
    for (const a of HOTKEYS) globalShortcut.unregister(a);
    this.stopCursorPoll();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.overlay = null;
    this.mouseOnWindow = false;
    this.dragging = false;
    if (this.dirs) {
      this.flushJsonl();
      this.flushBufferedPrints();
    }
    logInfo(`anotações: detach (${this.events.length} eventos)`);
  }

  private flushBufferedPrints(): void {
    const dirs = this.dirs;
    if (!dirs || !this.bufferedPrints.length) return;
    try {
      fs.mkdirSync(dirs.frames, { recursive: true });
      for (const p of this.bufferedPrints) {
        fs.writeFileSync(path.join(dirs.frames, p.name), Buffer.from(p.b64, "base64"));
      }
      logInfo(`anotações: ${this.bufferedPrints.length} prints em buffer salvos`);
      this.bufferedPrints = [];
    } catch (e) {
      logError("anotações: falha ao salvar prints em buffer:", e);
    }
  }

  /** Ditado: persiste log+buffer quando o dir passa a existir (no stop). */
  private flushJsonl(): void {
    if (!this.dirs || !this.events.length) return;
    try {
      fs.mkdirSync(this.dirs.root, { recursive: true });
      const file = path.join(this.dirs.root, "annotations.jsonl");
      for (const ev of this.events) fs.appendFileSync(file, JSON.stringify(ev) + "\n");
      logInfo(`anotações: log persistido (${this.events.length} eventos)`);
    } catch (e) {
      logError("anotações: falha ao persistir annotations.jsonl:", e);
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
    });
    wireLogging(w, "annotation");
    this.overlay = w;
    this.startCursorPoll();
  }

  /**
   * Hover da paleta sem depender de forwarded mousemove (não chegava ao
   * renderer nesta máquina): main faz polling do cursor e habilita o mouse
   * da janela quando o cursor está sobre a paleta (modo pass-through apenas).
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
          logInfo(`anotações: poll cursor → mouse da janela ${inside ? "ON" : "off"}`);
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

  /** Modo: desenho (mouse+teclado) ou pass-through (usuário no app embaixo). */
  setPassThrough(passThrough: boolean): void {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    this.drawMode = !passThrough;
    this.mouseOnWindow = !passThrough; // poll não briga com o setPassThrough
    logInfo(`anotações: modo ${passThrough ? "pass-through" : "desenho"}`);
    w.setIgnoreMouseEvents(passThrough, { forward: true });
    w.setFocusable(!passThrough);
    if (!passThrough) w.focus();
    const cmd: AnnotationCmd = { type: "pass-through", on: passThrough };
    w.webContents.send(IPC.annotationCmd, cmd);
  }

  private cmdTool(tool: AnnotationTool): void {
    this.tool = tool;
    if (!this.drawMode) this.setPassThrough(false);
    const cmd: AnnotationCmd = { type: "tool", tool, eraserMode: this.eraserMode };
    this.overlay?.webContents.send(IPC.annotationCmd, cmd);
  }

  /** Hover da paleta: mouse da janela temporário (só em pass-through). */
  setWindowMouse(mouse: boolean): void {
    const w = this.overlay;
    if (w && !w.isDestroyed() && !this.drawMode) {
      w.setIgnoreMouseEvents(!mouse, { forward: true });
    }
  }

  /** Drag da paleta (pass-through): mouse da janela travado ON até soltar. */
  setPaletteDragging(dragging: boolean): void {
    const w = this.overlay;
    if (!w || w.isDestroyed() || this.drawMode) return;
    this.dragging = dragging;
    this.mouseOnWindow = dragging; // poll não briga no meio do drag
    w.setIgnoreMouseEvents(!dragging, { forward: true });
  }

  /** Entrar no modo desenho pela PALETA (sem hotkey) — ativa a ferramenta. */
  enterDrawMode(tool?: AnnotationTool): void {
    this.cmdTool(tool ?? this.tool);
  }

  private registerHotkeys(): void {
    const reg = (accel: string, fn: () => void) => {
      if (!globalShortcut.register(accel, fn)) logError(`anotações: hotkey ${accel} indisponível`);
    };
    reg("Control+Alt+L", () => this.cmdTool("laser"));
    reg("Control+Alt+B", () => this.cmdTool("brush"));
    reg("Control+Alt+E", () => this.cmdTool("eraser"));
    reg("Control+Alt+C", () => void this.record({ kind: "clear" }));
    reg("Control+Alt+Space", () => this.setPassThrough(this.drawMode));
    reg("Control+Alt+P", () => void this.captureComposite("manual", false));
    reg("Control+Alt+H", () => this.togglePalette());
  }

  /** Paleta visível/oculta — botão da própria paleta e Ctrl+Alt+H. */
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

  record(req: AnnotationEventRequest): AnnotationEvent | null {
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
    M_EVENTS?.add(1, { tipo: ev.type });
    // D7: rajada de anotação no modo somente-transcrição agenda print
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
      logError("anotações: falha ao escrever annotations.jsonl:", e);
    }
  }

  // ── prints (manual / auto D7 / marker D6) ───────────────────────────

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

  /** Marker (D6): frame + marcações queimadas. Chamar de capture.addMarker. */
  async marker(n: number): Promise<void> {
    if (await this.captureComposite("marker", true, `marker-${n}`)) {
      M_PRINTS?.add(1, { kind: "marker" });
    }
  }

  /**
   * Captura o frame do display, pede o composite ao overlay (strokes/lasers
   * recentes por cima) e salva em frames/. kind=manual não queima strokes.
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
        logError("anotações: nenhuma fonte de tela p/ print");
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
        logError("anotações: composite não retornou (timeout)");
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
        this.bufferedPrints.push({ name, b64 }); // log do ditado sai inteiro no flush
      }
      logInfo(`anotações: print ${kind} → frames/${name}`);
      return true;
    } catch (e) {
      logError("anotações: captureComposite falhou:", e);
      return false;
    }
  }

  /** Contexto p/ o overlay compor o print (chamado via IPC pelo próprio). */
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

  /** Print manual pela paleta (mesmo caminho do Ctrl+Alt+P). */
  manualPrint(): void {
    void this.captureComposite("manual", false).then((ok) => {
      if (ok) M_PRINTS?.add(1, { kind: "manual" });
    });
  }
}

// ── singleton + IPC ────────────────────────────────────────────────────────

export const annotations = new AnnotationEngine();

/** Contexto do overlay precisa vir pelo IPC (main é a fonte do estado). */
export function registerAnnotationIpc(): void {
  ipcMain.handle(IPC.annotationEvent, (_e, req: AnnotationEventRequest) => annotations.record(req));
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
  /** Overlay pede o estado p/ compor o print (strokes/lasers ativos). */
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
}
