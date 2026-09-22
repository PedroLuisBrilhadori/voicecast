/**
 * Overlay de anotações (AN.1) — canvas fullscreen transparente sobre a tela.
 *
 * O main é a fonte da verdade (annotations.jsonl): todo evento passa por
 * vcInternal.annotationEvent (invoke) e volta com seq/t/ids; o estado local é
 * re-fold do log (mesmo motor puro do main — shared/annotations).
 * Modo desenho: pointer + teclado (Ctrl+Z/Y, Esc). Pass-through: a janela
 * ignora o mouse (usuário interage com o app embaixo); a paleta aciona o
 * mouse da janela no hover.
 */
import { useEffect, useRef, useState } from "react";
import {
  foldEvents,
  hitStrokes,
  simplifyPoints,
  splitStrokesByPath,
  type AnnotationEvent,
  type AnnotationTool,
  type EraserMode,
  type Pt,
  type StrokeSnapshot,
} from "../shared/annotations";

declare global {
  interface Window {
    vcInternal: import("../shared/ipc").VcInternalBridge;
  }
}

const DPR = Number(new URLSearchParams(location.search).get("dpr") ?? "1");
const CORES = ["#ff4444", "#ffd60a", "#34d399", "#22d3ee"] as const;
const ESPESSURAS = [3, 6, 10] as const;
const LASER_FADE_MS = 600;

type Tool = { tool: AnnotationTool; eraserMode: EraserMode; color: string; width: number };

export function AnnotationApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<AnnotationEvent[]>([]);
  const strokesRef = useRef<StrokeSnapshot[]>([]); // fold do log (ativo)
  const drawingRef = useRef<Pt[] | null>(null); // stroke/laser/borracha em andamento
  const lasersRef = useRef<{ at: number; points: Pt[] }[]>([]); // trails vivos (fade)
  const toolRef = useRef<Tool>({ tool: "brush", eraserMode: "stroke", color: CORES[0], width: ESPESSURAS[1] });
  const passThroughRef = useRef(true);
  const [passThrough, setPassThroughS] = useState(true);
  const [tool, setToolS] = useState<Tool>(toolRef.current);
  const paletaRef = useRef<HTMLDivElement>(null);
  const [, forceRender] = useState(0);
  // paleta móvel (mantenedor 2026-09-22: mover como o indicador de gravação);
  // null = posição default (centro, bottom 48)
  const [palPos, setPalPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [palHidden, setPalHiddenS] = useState(false);
  const [standalone, setStandaloneS] = useState(false);

  const setTool = (patch: Partial<Tool>) => {
    toolRef.current = { ...toolRef.current, ...patch };
    setToolS(toolRef.current);
  };
  const setPassThrough = (on: boolean) => {
    passThroughRef.current = on;
    setPassThroughS(on);
    // laser mostra o cursor real (mantenedor 2026-09-22: "quando eu clico no
    // laser, meu mouse some") — nenhuma ferramenta esconde o mouse
    document.body.style.cursor = on ? "default" : "crosshair";
  };

  // main faz polling do cursor sobre este retângulo p/ habilitar o mouse
  useEffect(() => {
    const report = () => {
      const el = paletaRef.current;
      if (!el) {
        // paleta oculta: limpa o retângulo (hover do poll não deve ligar o mouse)
        window.vcInternal.annotationPaletteBounds(null);
        return;
      }
      const r = el.getBoundingClientRect();
      window.vcInternal.annotationPaletteBounds({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    const t = setTimeout(report, 300);
    window.addEventListener("resize", report);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", report);
    };
  }, [palPos, palHidden]);

  // ── drag da paleta (fundo/grip; botões e controles não arrastam) ──────
  const onPalPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.dataset.grip) return;
    const r = paletaRef.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // pass-through: mantém o mouse da janela ligado mesmo saindo do retângulo
    void window.vcInternal.annotationMouse({ mouse: true, from: "drag" });
  };
  const onPalPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const r = paletaRef.current?.getBoundingClientRect();
    if (!d || !r) return;
    const x = Math.min(Math.max(8, e.clientX - d.dx), window.innerWidth - r.width - 8);
    const y = Math.min(Math.max(8, e.clientY - d.dy), window.innerHeight - r.height - 8);
    setPalPos({ x, y });
  };
  const onPalPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    void window.vcInternal.annotationMouse({ mouse: false, from: "drag" });
  };

  const refold = () => {
    strokesRef.current = foldEvents(logRef.current).strokes;
  };

  // ── render loop (strokes + em-andamento + lasers com fade) ────────────
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const ctx = cv.getContext("2d")!;
        ctx.clearRect(0, 0, cv.width, cv.height);
        const now = performance.now();
        const drawStroke = (st: { color?: string; width?: number; points: Pt[] }, alpha = 1, color?: string, width?: number) => {
          if (st.points.length < 2) return;
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = color ?? st.color ?? "#ff4444";
          ctx.lineWidth = width ?? st.width ?? 6;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(st.points[0]!.x, st.points[0]!.y);
          for (let i = 1; i < st.points.length; i++) ctx.lineTo(st.points[i]!.x, st.points[i]!.y);
          ctx.stroke();
        };
        // ativos (fold do log)
        for (const st of strokesRef.current) drawStroke(st);
        // em andamento
        const cur = drawingRef.current;
        if (cur && toolRef.current.tool === "brush") {
          drawStroke({ color: toolRef.current.color, width: toolRef.current.width, points: cur });
        }
        if (cur && toolRef.current.tool === "eraser") {
          // cursor da borracha
          const p = cur[cur.length - 1]!;
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, toolRef.current.width * 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        // lasers: trail com fade (rastro: segmentos com alpha decrescente)
        lasersRef.current = lasersRef.current.filter((l) => now - l.at < LASER_FADE_MS);
        for (const l of lasersRef.current) {
          const age = (now - l.at) / LASER_FADE_MS;
          if (l.points.length >= 2) {
            drawStroke({ points: l.points }, Math.max(0, 1 - age), "#ff2d2d", 5);
            // ponto quente
            const p = l.points[l.points.length - 1]!;
            ctx.globalAlpha = Math.max(0, 1 - age);
            ctx.fillStyle = "#ff2d2d";
            ctx.beginPath();
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── canvas sizing (px físicos — CSS cobre a tela inteira) ─────────────
  useEffect(() => {
    const fit = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      cv.width = Math.round(window.innerWidth * DPR);
      cv.height = Math.round(window.innerHeight * DPR);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // ── comandos do main (tool / pass-through / capture) ──────────────────
  useEffect(() => {
    const off = window.vcInternal.onAnnotationCmd((cmd) => {
      if (cmd.type === "tool") {
        setTool({ tool: cmd.tool, eraserMode: cmd.eraserMode ?? toolRef.current.eraserMode });
        setPassThrough(false);
      } else if (cmd.type === "pass-through") {
        setPassThrough(cmd.on);
      } else if (cmd.type === "palette") {
        setPalHiddenS(!cmd.on);
      } else if (cmd.type === "mode") {
        setStandaloneS(cmd.standalone);
      } else if (cmd.type === "capture") {
        void composite(cmd.id, cmd.frame);
      }
    });
    return off;
  }, []);

  /** Frame + strokes/lasers ativos → PNG b64 de volta pro main. */
  async function composite(id: string, frame: string): Promise<void> {
    try {
      const ctxData = window.vcInternal.annotationContext();
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("frame não carregou"));
        img.src = frame;
      });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const c = cv.getContext("2d")!;
      c.drawImage(img, 0, 0);
      // strokes no MESMO espaço físico do frame
      for (const st of ctxData.strokes) {
        if (st.points.length < 2) continue;
        c.strokeStyle = st.color;
        c.lineWidth = st.width;
        c.lineCap = "round";
        c.lineJoin = "round";
        c.beginPath();
        c.moveTo(st.points[0]!.x, st.points[0]!.y);
        for (let i = 1; i < st.points.length; i++) c.lineTo(st.points[i]!.x, st.points[i]!.y);
        c.stroke();
      }
      // lasers recentes entram queimados (registro de onde apontou)
      for (const l of ctxData.lasers) {
        if (l.points.length < 2) continue;
        c.strokeStyle = "#ff2d2d";
        c.lineWidth = 5;
        c.globalAlpha = 0.85;
        c.beginPath();
        c.moveTo(l.points[0]!.x, l.points[0]!.y);
        for (let i = 1; i < l.points.length; i++) c.lineTo(l.points[i]!.x, l.points[i]!.y);
        c.stroke();
        c.globalAlpha = 1;
      }
      const b64 = cv.toDataURL("image/png").split(",")[1] ?? null;
      window.vcInternal.sendComposite(id, b64);
    } catch {
      window.vcInternal.sendComposite(id, null);
    }
  }

  // ── teclado (só recebe em modo desenho — janela focusable) ────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void window.vcInternal.annotationMouse({ mouse: false, from: "esc" });
        setPassThrough(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void window.vcInternal.annotationEvent({ kind: e.shiftKey ? "redo" : "undo" }).then((ev) => {
          if (ev) {
            logRef.current.push(ev);
            refold();
          }
        });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void window.vcInternal.annotationEvent({ kind: "redo" }).then((ev) => {
          if (ev) {
            logRef.current.push(ev);
            refold();
          }
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── AN.6: roda no modo desenho → main repassa à janela de baixo ───────
  // Fora do React (onWheel do root é passive): precisa de preventDefault.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (passThroughRef.current) return; // pass-through: a roda já é do app de baixo
      e.preventDefault();
      window.vcInternal.annotationWheel({
        cx: Math.round(e.clientX * DPR),
        cy: Math.round(e.clientY * DPR),
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        buttons: e.buttons,
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // ── pointer (modo desenho) ────────────────────────────────────────────
  const toPhysical = (e: React.PointerEvent): Pt => ({
    x: Math.round(e.clientX * DPR),
    y: Math.round(e.clientY * DPR),
    ms: Math.round(performance.now()),
  });

  const onDown = (e: React.PointerEvent) => {
    if (passThroughRef.current) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = [toPhysical(e)];
  };

  const onMove = (e: React.PointerEvent) => {
    if (passThroughRef.current) return;
    const cur = drawingRef.current;
    if (!cur) return;
    const p = toPhysical(e);
    const last = cur[cur.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return; // throttle 2px
    cur.push(p);
    if (toolRef.current.tool === "laser") {
      // trail vivo: renasce a cada movimento (fade conta desde o último ponto)
      const alive = lasersRef.current[lasersRef.current.length - 1];
      if (alive && performance.now() - alive.at < 80) alive.points.push(p);
      else lasersRef.current.push({ at: performance.now(), points: [p] });
      lasersRef.current[lasersRef.current.length - 1]!.at = performance.now();
    }
  };

  const onUp = async () => {
    const cur = drawingRef.current;
    drawingRef.current = null;
    if (!cur || cur.length < 2) return;
    const t = toolRef.current;
    if (t.tool === "brush") {
      const ev = await window.vcInternal.annotationEvent({
        kind: "stroke",
        color: t.color,
        width: t.width,
        points: simplifyPoints(cur),
      });
      if (ev) {
        logRef.current.push(ev);
        refold();
      }
    } else if (t.tool === "laser") {
      // caminho persiste no log (atenção); visual continua fade local
      const ev = await window.vcInternal.annotationEvent({ kind: "laser", points: simplifyPoints(cur) });
      if (ev) logRef.current.push(ev);
    } else if (t.tool === "eraser") {
      if (t.eraserMode === "stroke") {
        const alvo = hitStrokes(strokesRef.current, cur, t.width * 2.5);
        if (alvo.length) {
          const ev = await window.vcInternal.annotationEvent({ kind: "erase-stroke", snapshots: alvo });
          if (ev) {
            logRef.current.push(ev);
            refold();
          }
        }
      } else {
        const { removed, added } = splitStrokesByPath(strokesRef.current, cur, t.width * 2.5, (_sid, i) => `tmp.${i}`);
        if (removed.length) {
          const ev = await window.vcInternal.annotationEvent({
            kind: "erase-area",
            removed,
            added: added.map(({ id: _id, ...rest }) => rest),
          });
          if (ev) {
            logRef.current.push(ev);
            refold();
          }
        }
      }
    }
  };

  // ── paleta ────────────────────────────────────────────────────────────
  const btn = (ativo: boolean): React.CSSProperties => ({
    background: ativo ? "#2d1b3d" : "#1a1a22",
    border: `1px solid ${ativo ? "#7c4dff" : "#2a2a34"}`,
    color: "#e8e8ee",
    borderRadius: 8,
    padding: "4px 10px",
    font: "600 12px system-ui",
    cursor: "pointer",
  });

  const paleta = (
    <div
      ref={paletaRef}
      onPointerDown={onPalPointerDown}
      onPointerMove={onPalPointerMove}
      onPointerUp={onPalPointerUp}
      onPointerCancel={onPalPointerUp}
      onMouseEnter={() => void window.vcInternal.annotationMouse({ mouse: true, from: "palette" })}
      onMouseLeave={() => void window.vcInternal.annotationMouse({ mouse: false, from: "palette" })}
      style={{
        position: "fixed",
        ...(palPos ? { left: palPos.x, top: palPos.y } : { bottom: 48, left: "50%", transform: "translateX(-50%)" }),
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "8px 12px",
        background: "rgba(12,12,16,0.92)",
        border: "1px solid #2a2a34",
        borderRadius: 12,
        userSelect: "none",
      }}
    >
      <div
        data-grip="1"
        title="segure para mover a paleta"
        style={{ cursor: dragRef.current ? "grabbing" : "grab", font: "700 14px system-ui", color: "#6a6a78", padding: "0 2px" }}
      >
        ⠿
      </div>
      <button style={btn(tool.tool === "laser" && !passThrough)} onClick={() => { setTool({ tool: "laser" }); void window.vcInternal.annotationMouse({ mouse: true, from: "draw", tool: "laser" }); }} title="Laser (Ctrl+Alt+G)">
        Laser
      </button>
      <button style={btn(tool.tool === "brush" && !passThrough)} onClick={() => { setTool({ tool: "brush" }); void window.vcInternal.annotationMouse({ mouse: true, from: "draw", tool: "brush" }); }} title="Pincel (Ctrl+Alt+B)">
        Pincel
      </button>
      <button style={btn(tool.tool === "eraser" && !passThrough)} onClick={() => { setTool({ tool: "eraser" }); void window.vcInternal.annotationMouse({ mouse: true, from: "draw", tool: "eraser" }); }} title="Borracha (Ctrl+Alt+E)">
        Borracha
      </button>
      {tool.tool === "eraser" && (
        <button
          style={btn(tool.eraserMode === "area")}
          onClick={() => setTool({ eraserMode: tool.eraserMode === "stroke" ? "area" : "stroke" })}
          title="Modo da borracha: traço inteiro ↔ por proximidade"
        >
          {tool.eraserMode === "stroke" ? "modo: traço" : "modo: normal"}
        </button>
      )}
      {tool.tool === "brush" && (
        <>
          {CORES.map((c) => (
            <span
              key={c}
              onClick={() => setTool({ color: c })}
              style={{
                width: 16,
                height: 16,
                borderRadius: 99,
                background: c,
                cursor: "pointer",
                outline: tool.color === c ? "2px solid #fff" : "1px solid #333",
              }}
            />
          ))}
          {ESPESSURAS.map((w) => (
            <span
              key={w}
              onClick={() => setTool({ width: w })}
              style={{
                width: 18,
                height: 18,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                background: tool.width === w ? "#2d1b3d" : "transparent",
                border: `1px solid ${tool.width === w ? "#7c4dff" : "#2a2a34"}`,
              }}
            >
              <span style={{ width: w, height: w, borderRadius: 99, background: "#e8e8ee" }} />
            </span>
          ))}
        </>
      )}
      <span style={{ width: 1, height: 20, background: "#2a2a34" }} />
      <button style={btn(false)} onClick={() => void window.vcInternal.annotationEvent({ kind: "undo" }).then((ev) => { if (ev) { logRef.current.push(ev); refold(); } })} title="Desfazer (Ctrl+Z)">
        ↶
      </button>
      <button style={btn(false)} onClick={() => void window.vcInternal.annotationEvent({ kind: "redo" }).then((ev) => { if (ev) { logRef.current.push(ev); refold(); } })} title="Refazer (Ctrl+Shift+Z)">
        ↷
      </button>
      <button style={btn(false)} onClick={() => void window.vcInternal.annotationEvent({ kind: "clear" }).then((ev) => { if (ev) { logRef.current.push(ev); refold(); } })} title="Limpar tudo (Ctrl+Alt+C ou Ctrl+Alt+X)">
        Limpar
      </button>
      <button style={btn(false)} onClick={() => void window.vcInternal.annotationPrint()} title="Print da tela para frames/ (Ctrl+Alt+P)">
        📷 Print
      </button>
      <button style={btn(false)} onClick={() => void window.vcInternal.annotationPaletteToggle()} title="Ocultar a paleta (Ctrl+Alt+H traz de volta)">
        ⏷ ocultar
      </button>
      {standalone && (
        <button style={btn(false)} onClick={() => void window.vcInternal.annotationClose()} title="Fechar o painel (descarta as anotações do rascunho)">
          ✕ fechar
        </button>
      )}
      {!passThrough ? (
        <span style={{ color: "#7c4dff", font: "600 11px system-ui" }}>desenhando · Esc solta o mouse</span>
      ) : (
        <span style={{ color: "#9a9aa8", font: "11px system-ui" }}>pass-through · Ctrl+Alt+Espaço desenha</span>
      )}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100vw", height: "100vh", display: "block", touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => void onUp()}
        onPointerCancel={() => void onUp()}
      />
      {!palHidden && paleta}
    </div>
  );
}
