import { useEffect, useRef, useState } from "react";
import { goalSummary, isGoalFinal, type GoalPhase, type GoalState } from "../shared/agent-goal";

declare global {
  interface Window {
    voicecast: import("../shared/ipc").VoicecastBridge;
  }
}

/** Cores da linha de goal do cockpit (mesma linguagem do ditado-state). */
const GOAL_UI: Record<GoalPhase, string> = {
  queued: "#f4b942",
  running: "#f4b942",
  completed: "#3ecf8e",
  failed: "#ff8a8a",
  timeout: "#ff8a8a",
  cancelled: "#9a9aa8",
};

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Desfecho do julgamento Jev (ditado-state phase "done"). */
const ROTA_UI: Record<string, string> = {
  ditado_texto: "✓ colado",
  comando_agente: "→ agente (não colado)",
  anotacao_contexto: "✎ guardado na sessão",
  conversa_social: "— conversa (ignorada)",
};

function desfechoDitado(r: { rota?: string; colado?: boolean }): string {
  if (r.colado) return "✓ colado";
  return (r.rota && ROTA_UI[r.rota]) || "não colado";
}

/** Barra compacta frameless: REC + timer + waveform + markers + controles.
 *  Janela inteira arrastável (app-region: drag); botões no-drag.
 *  Modo ditado (query ditado=1): sem foco, só timer + waveform + parar. */
export function BarApp() {
  const qs = new URLSearchParams(location.search);
  const mode = qs.get("mode") ?? "Gravação";
  const isDitado = qs.get("ditado") === "1";
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
  const [elapsed, setElapsed] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [asrLoading, setAsrLoading] = useState(false);
  const [expectedLoadS, setExpectedLoadS] = useState<number | null>(null);
  const [transcribingS, setTranscribingS] = useState(0);
  const [resultado, setResultado] = useState<{ rota?: string; conf?: number; colado?: boolean } | null>(null);
  const [markers, setMarkers] = useState(0);
  const [paused, setPaused] = useState(false);
  /** C4: estado do goal do cockpit (linha dedicada, mesma linguagem do ditado-state). */
  const [goal, setGoal] = useState<GoalState | null>(null);
  const goalClear = useRef<number | null>(null);
  /** True entre o pedido de start e a captura abrir (main emite com arming). */
  const [arming, setArming] = useState(false);
  const levels = useRef<number[]>([]);
  const [, forceRender] = useState(0);

  useEffect(() => {
    // snapshot inicial (goal pode ter começado antes da barra abrir)
    window.voicecast.agentGetState().then((s) => s && setGoal(s)).catch(() => {});
    const off = window.voicecast.onEvent((e) => {
      if (e.type === "mic-level") {
        levels.current = [...levels.current.slice(-59), e.level];
        forceRender((n) => n + 1);
      } else if (e.type === "state") {
        setArming(!!e.state.arming);
        if (e.state.startedAt) {
          setMarkers(e.state.markers.length);
          setPaused(e.state.paused);
        }
      } else if (e.type === "ditado-state") {
        if (e.phase === "done") {
          setTranscribing(false);
          setAsrLoading(false);
          setResultado({ rota: e.rota, conf: e.conf, colado: e.colado });
        } else {
          setTranscribing(e.phase === "transcribing");
          setAsrLoading(e.phase === "transcribing" && !!e.asrLoading);
          setExpectedLoadS(e.expectedLoadS ?? null);
        }
      } else if (e.type === "agent-state") {
        setGoal(e.state);
        // desfecho aparece no fim e some depois — sem notificação intrusiva
        if (goalClear.current) window.clearTimeout(goalClear.current);
        goalClear.current = isGoalFinal(e.state.phase)
          ? window.setTimeout(() => setGoal(null), 6_000)
          : null;
      }
    });
    const t = window.setInterval(() => forceRender((n) => n + 1), 500);
    return () => {
      off();
      clearInterval(t);
      if (goalClear.current) window.clearTimeout(goalClear.current);
    };
  }, []);

  // timer por polling do estado (ditado não expõe startedAt via getState: usa relógio local)
  useEffect(() => {
    if (isDitado) {
      const t0 = Date.now();
      const iv = window.setInterval(() => {
        if (!transcribing) setElapsed((Date.now() - t0) / 1000);
        else setTranscribingS((Date.now() - t0) / 1000);
      }, 500);
      return () => clearInterval(iv);
    }
    let alive = true;
    const tick = () =>
      window.voicecast.getState().then((s) => {
        if (!alive) return;
        setArming(!!s.arming);
        if (!s.startedAt || s.arming) return; // arming: timer só depois do REC real
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
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {resultado ? (
          <span
            style={{
              color: resultado.colado ? "#3ecf8e" : "#7c4dff",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {desfechoDitado(resultado)}
          </span>
        ) : transcribing ? (
          <span style={{ color: "#f4b942", fontSize: 12.5, fontWeight: 600 }}>
            ⏳ transcrevendo · {Math.floor(transcribingS)}s
            {asrLoading && (
              <span title="o modelo de transcrição carrega na GPU na primeira uso após o boot — as próximas são rápidas">
                {" "}· ASR carregando modelo{expectedLoadS ? ` (≈${Math.round(expectedLoadS)}s)` : ""}
              </span>
            )}
          </span>
        ) : arming && !isDitado ? (
          <span style={{ color: "#f4b942", fontSize: 12.5, fontWeight: 600 }}>⏳ preparando captura…</span>
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

      {/* C4: linha de estado do goal do cockpit — uma linha, sem intrusão */}
      {goal && (
        <span
          title={`goal: ${goal.goal}`}
          style={{
            color: GOAL_UI[goal.phase],
            fontSize: 12.5,
            fontWeight: 600,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ● {goalSummary(goal)}
        </span>
      )}

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
          style={{ background: "#2d1b3d", borderColor: "#7c4dff", padding: "4px 14px", fontWeight: 700, ...noDrag }}
        >
          ■ Parar
        </button>
      ) : (
        <>
          <button
            title="Marcar momento (Ctrl+M)"
            onClick={() => void window.voicecast.addMarker()}
            disabled={arming}
            style={{ padding: "4px 10px", opacity: arming ? 0.4 : 1, ...noDrag }}
          >
            ◆ {markers}
          </button>
          <button
            onClick={() => {
              setPaused(!paused);
              void window.voicecast.pause(!paused);
            }}
            disabled={arming}
            style={{ padding: "4px 10px", opacity: arming ? 0.4 : 1, ...noDrag }}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <button
            onClick={() => void window.voicecast.stopRecording()}
            disabled={arming}
            style={{ background: "#2d1b3d", borderColor: "#7c4dff", padding: "4px 14px", fontWeight: 700, opacity: arming ? 0.4 : 1, ...noDrag }}
          >
            ■ Parar
          </button>
          <button
            title="Cancelar (não salva)"
            onClick={() => void window.voicecast.cancelRecording()}
            style={{ padding: "4px 10px", color: "#ff8a8a", ...noDrag }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
