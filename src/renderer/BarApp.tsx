import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    voicecast: import("../shared/ipc").VoicecastBridge;
  }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Barra compacta frameless: REC + timer + waveform + markers + controles.
 *  Arrastável pela área esquerda (-webkit-app-region: drag).
 *  Modo ditado (query ditado=1): sem foco, só timer + waveform + parar. */
export function BarApp() {
  const qs = new URLSearchParams(location.search);
  const mode = qs.get("mode") ?? "Gravação";
  const isDitado = qs.get("ditado") === "1";
  const [elapsed, setElapsed] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [markers, setMarkers] = useState(0);
  const [paused, setPaused] = useState(false);
  const levels = useRef<number[]>([]);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const off = window.voicecast.onEvent((e) => {
      if (e.type === "mic-level") {
        levels.current = [...levels.current.slice(-59), e.level];
        forceRender((n) => n + 1);
      } else if (e.type === "state" && e.state.startedAt) {
        setMarkers(e.state.markers.length);
        setPaused(e.state.paused);
      } else if (e.type === "ditado-state") {
        setTranscribing(e.phase === "transcribing");
      }
    });
    const t = window.setInterval(() => forceRender((n) => n + 1), 500);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  // timer por polling do estado (ditado não expõe startedAt via getState: usa relógio local)
  useEffect(() => {
    if (isDitado) {
      const t0 = Date.now();
      const iv = window.setInterval(() => {
        if (!transcribing) setElapsed((Date.now() - t0) / 1000);
      }, 500);
      return () => clearInterval(iv);
    }
    let alive = true;
    const tick = () =>
      window.voicecast.getState().then((s) => {
        if (!alive || !s.startedAt) return;
        setElapsed((Date.now() - s.startedAt) / 1000);
        setMarkers(s.markers.length);
        setPaused(s.paused);
      });
    tick();
    const iv = window.setInterval(tick, 500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [isDitado]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: "100vh",
        padding: "0 12px",
        background: "linear-gradient(180deg,#15151b,#0c0c10)",
        border: "1px solid #2a2a34",
        borderRadius: 12,
        color: "#e8e8ee",
        font: "13px system-ui",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, WebkitAppRegion: "drag" } as React.CSSProperties}>
        {transcribing ? (
          <span style={{ color: "#f4b942", fontSize: 12.5, fontWeight: 600 }}>⏳ transcrevendo…</span>
        ) : (
          <>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: paused ? "#f4b942" : "#ff5555",
                boxShadow: paused ? "none" : "0 0 8px #ff5555",
                animation: paused ? "none" : "pulse 1.2s infinite",
              }}
            />
            <strong style={{ fontSize: 14, minWidth: 46 }}>{fmt(elapsed)}</strong>
          </>
        )}
        <span style={{ color: "#9a9aa8", fontSize: 11 }}>{mode}</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 22, flex: 1, overflow: "hidden" }}>
        {levels.current.map((l, i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: Math.max(2, Math.min(22, l * 90)),
              background: "#3ecf8e",
              opacity: 0.35 + (i / levels.current.length) * 0.65,
              borderRadius: 1,
            }}
          />
        ))}
        {levels.current.length === 0 && <span style={{ color: "#55555f", fontSize: 10 }}>mic…</span>}
      </div>

      {isDitado ? (
        <button
          onClick={() => void window.voicecast.ditadoToggle()}
          style={{ background: "#2d1b3d", borderColor: "#7c4dff", padding: "4px 14px", fontWeight: 700 }}
        >
          ■ Parar
        </button>
      ) : (
        <>
          <button
            title="Marcar momento (Ctrl+M)"
            onClick={() => void window.voicecast.addMarker()}
            style={{ padding: "4px 10px" }}
          >
            ◆ {markers}
          </button>
          <button
            onClick={() => {
              setPaused(!paused);
              void window.voicecast.pause(!paused);
            }}
            style={{ padding: "4px 10px" }}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <button
            onClick={() => void window.voicecast.stopRecording()}
            style={{ background: "#2d1b3d", borderColor: "#7c4dff", padding: "4px 14px", fontWeight: 700 }}
          >
            ■ Parar
          </button>
          <button
            title="Cancelar (não salva)"
            onClick={() => void window.voicecast.cancelRecording()}
            style={{ padding: "4px 10px", color: "#ff8a8a" }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
