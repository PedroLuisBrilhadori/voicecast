import { useCallback, useEffect, useState } from "react";
import type { Bootstrap, RecordingState, SourceInfo, StartRecordingRequest } from "../shared/ipc";

declare global {
  interface Window {
    voicecast: import("../shared/ipc").VoicecastBridge;
  }
}

type Tab = "screen" | "window" | "region";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [state, setState] = useState<RecordingState>({ phase: "idle", mode: null, startedAt: null, paused: false, markers: [] });
  const [tab, setTab] = useState<Tab>("screen");
  const [screens, setScreens] = useState<SourceInfo[]>([]);
  const [windows, setWindows] = useState<SourceInfo[]>([]);
  const [search, setSearch] = useState("");
  const [regionRect, setRegionRect] = useState<import("../shared/ipc").Rect | null>(null);
  const [withMic, setWithMic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.voicecast.getBootstrap().then(setBoot).catch(console.error);
    const off = window.voicecast.onEvent((e) => {
      if (e.type === "state") setState(e.state);
      if (e.type === "session-error") setError(e.message);
    });
    window.voicecast.getState().then(setState);
    return off;
  }, []);

  const refreshSources = useCallback(() => {
    window.voicecast.listSources("screen").then(setScreens).catch(console.error);
    window.voicecast.listSources("window").then(setWindows).catch(console.error);
  }, []);

  useEffect(() => {
    refreshSources();
    const iv = setInterval(refreshSources, 2500);
    return () => clearInterval(iv);
  }, [refreshSources]);

  const start = useCallback(
    async (req: Omit<StartRecordingRequest, "withMic">) => {
      setError(null);
      setBusy(true);
      try {
        const res = await window.voicecast.startRecording({ ...req, withMic });
        if (!res.ok) setError(res.error ?? "falha ao iniciar");
        else window.close(); // gravação começou: painel some, barra fica
      } finally {
        setBusy(false);
      }
    },
    [withMic],
  );

  const pickRegion = useCallback(async () => {
    setError(null);
    const rect = await window.voicecast.selectRegion(0);
    if (rect) setRegionRect(rect);
  }, []);

  const recording = state.phase !== "idle";

  const filteredWindows = windows.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="app">
      <header>
        <h1>
          voicecast <span className="tag">{boot ? `v${boot.version}` : "…"}</span>
          {recording && (
            <span className="tag rec-live">● {state.phase === "processing" ? "processando" : "REC"}</span>
          )}
        </h1>
        <p className="sub">
          Grave voz + tela, transcreva local e vire contexto para o agente.{" "}
          <kbd>{boot?.shortcuts.togglePanel ?? "Ctrl+F9"}</kbd> abre/oculta este painel ·{" "}
          <kbd>{boot?.shortcuts.recordFullscreen ?? "Ctrl+Shift+F9"}</kbd> grava a tela inteira já.
        </p>
      </header>

      {error && (
        <div className="error-bar">
          {error} <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="tabs">
        {(
          [
            ["screen", "🖥 Tela cheia"],
            ["window", "🪟 Janela"],
            ["region", "▭ Região"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <main className="content">
        {tab === "screen" && (
          <div className="grid">
            {screens.map((s) => (
              <button
                key={s.id}
                className="card"
                disabled={recording || busy}
                onClick={() => void start({ mode: "screen", sourceId: s.id })}
              >
                <img src={s.thumb} alt="" />
                <span>{s.name}</span>
              </button>
            ))}
            {!screens.length && <p className="muted">Nenhuma tela detectada ainda…</p>}
          </div>
        )}

        {tab === "window" && (
          <>
            <input
              className="search"
              placeholder="Buscar janela…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="grid wins">
              {filteredWindows.map((w) => (
                <button
                  key={w.id}
                  className="card"
                  title={w.name}
                  disabled={recording || busy}
                  onClick={() => void start({ mode: "window", sourceId: w.id })}
                >
                  <img src={w.thumb} alt="" />
                  <span>{w.name.length > 46 ? w.name.slice(0, 46) + "…" : w.name}</span>
                </button>
              ))}
              {!filteredWindows.length && <p className="muted">Nenhuma janela com esse nome.</p>}
            </div>
          </>
        )}

        {tab === "region" && (
          <div className="region-pane">
            <button className="big" disabled={recording || busy} onClick={() => void pickRegion()}>
              ▭ Selecionar área na tela
            </button>
            <p className="muted">
              Um overlay fullscreen abre — arraste o retângulo, Enter confirma, Esc cancela.
            </p>
            {regionRect ? (
              <div className="region-summary">
                <span>
                  Selecionado: <strong>{regionRect.width}×{regionRect.height}</strong> px
                </span>
                <button className="go" disabled={recording || busy} onClick={() => void pickRegion()}>
                  Re-selecionar
                </button>
                <button
                  className="go big"
                  disabled={recording || busy}
                  onClick={() => void start({ mode: "region", rect: regionRect })}
                >
                  ● Gravar região
                </button>
              </div>
            ) : (
              <p className="muted">Nada selecionado ainda.</p>
            )}
          </div>
        )}
      </main>

      <footer>
        <label className="mic">
          <input
            type="checkbox"
            checked={withMic}
            onChange={(e) => setWithMic(e.target.checked)}
            disabled={recording}
          />
          🎙 microfone
        </label>

        {tab === "screen" && (
          <button
            className="big go"
            disabled={!screens.length || recording || busy}
            onClick={() => void start({ mode: "screen", sourceId: screens[0]?.id })}
          >
            ● Gravar tela
          </button>
        )}
        {tab === "window" && (
          <p className="muted" style={{ margin: 0 }}>
            Clique na janela desejada acima para gravá-la.
          </p>
        )}
      </footer>
    </div>
  );
}
