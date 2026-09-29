import { useEffect, useRef, useState } from "react";
import type { Rect } from "../shared/ipc";

declare global {
  interface Window {
    voicecast: import("../shared/ipc").VoicecastBridge;
    vcInternal: import("../shared/ipc").VcInternalBridge;
  }
}

const params = new URLSearchParams(location.search);
const CH = params.get("ch") ?? "";
const DPR = Number(params.get("dpr") ?? "1");
const IDX = Number(params.get("idx") ?? "0");

/** Overlay de seleção de região (um por display — todos abrem juntos):
 *  ARRASTAR e SOLTAR confirma (mouse-first), Esc/✕ cancela. O primeiro
 *  resultado fecha todos os overlays. Resultado em px FÍSICOS + displayIndex. */
export function OverlayApp() {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rectRef = useRef<Rect | null>(null);
  const [hint, setHint] = useState("Arraste no monitor desejado · soltar confirma · Esc ou ✕ cancela");

  const cancel = () => {
    window.vcInternal.sendRegion(CH, null);
    window.close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cssRect = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  const confirmRect = () => {
    if (!cssRect || cssRect.width < 8 || cssRect.height < 8) return;
    const physical: Rect = {
      x: Math.round(cssRect.left * DPR),
      y: Math.round(cssRect.top * DPR),
      width: Math.round(cssRect.width * DPR),
      height: Math.round(cssRect.height * DPR),
    };
    rectRef.current = physical;
    window.vcInternal.sendRegion(CH, { rect: physical, displayIndex: IDX });
    window.close();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,8,12,0.35)",
        cursor: "crosshair",
        userSelect: "none",
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onMouseMove={(e) => {
        if (!drag) return;
        setDrag({ ...drag, x1: e.clientX, y1: e.clientY });
      }}
      onMouseUp={() => {
        // mouse-first: soltar com retângulo válido CONFIRMA (sem Enter)
        if (cssRect && cssRect.width >= 8 && cssRect.height >= 8) confirmRect();
        else if (cssRect) setHint("arraste uma área maior — ou Esc/✕ para cancelar");
      }}
      onDoubleClick={confirmRect}
    >
      {cssRect && (
        <>
          <div
            style={{
              position: "fixed",
              ...cssRect,
              border: "2px solid #7c4dff",
              background: "rgba(124,77,255,0.08)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "fixed",
              left: cssRect.left + cssRect.width - 4,
              top: cssRect.top + cssRect.height + 6,
              transform: "translateX(-100%)",
              background: "#7c4dff",
              color: "#fff",
              font: "bold 13px system-ui",
              padding: "3px 8px",
              borderRadius: 6,
              pointerEvents: "none",
            }}
          >
            {Math.round(cssRect.width * DPR)}×{Math.round(cssRect.height * DPR)}
          </div>
        </>
      )}
      <div
        style={{
          position: "fixed",
          top: 14,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(12,12,16,0.85)",
          color: "#e8e8ee",
          font: "14px system-ui",
          padding: "8px 16px",
          borderRadius: 10,
          pointerEvents: "none",
        }}
      >
        {hint}
      </div>
      <div style={{ position: "fixed", top: 12, right: 14, display: "flex", gap: 8 }}>
        <button
          onClick={() => {
            const physical: Rect = {
              x: 0,
              y: 0,
              width: Math.round(window.innerWidth * DPR),
              height: Math.round(window.innerHeight * DPR),
            };
            window.vcInternal.sendRegion(CH, { rect: physical, displayIndex: IDX });
            window.close();
          }}
          style={{
            background: "rgba(12,12,16,0.85)",
            color: "#e8e8ee",
            border: "1px solid #3a3a46",
            borderRadius: 8,
            font: "13px system-ui",
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          tela inteira
        </button>
        <button
          onClick={cancel}
          style={{
            background: "rgba(12,12,16,0.85)",
            color: "#e8e8ee",
            border: "1px solid #3a3a46",
            borderRadius: 8,
            font: "13px system-ui",
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          ✕ cancelar
        </button>
      </div>
    </div>
  );
}
