import { useCallback, useEffect, useState } from "react";
import type { Bootstrap, RecordingState, SessionSummary, SourceInfo, StartRecordingRequest } from "../shared/ipc";
import { goalSummary, type GoalState } from "../shared/agent-goal";

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
  const [regionDisplay, setRegionDisplay] = useState(0);
  const [withMic, setWithMic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "ditado" | "screen" | "window" | "region">("all");
  // C4 — cockpit: entrada digitada de goal (voz entra depois — F9 já roteia)
  const [goalText, setGoalText] = useState("");
  const [goalState, setGoalState] = useState<GoalState | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);

  const refreshSessions = useCallback(() => {
    window.voicecast.listSessions(sessionSearch).then(setSessions).catch(console.error);
  }, [sessionSearch]);

  useEffect(() => {
    refreshSessions();
    const off = window.voicecast.onEvent((e) => {
      if (e.type === "session-done" || e.type === "session-error" || e.type === "sessions-changed")
        refreshSessions();
    });
    return off;
  }, [refreshSessions]);

  // debounce da busca full-text
  useEffect(() => {
    const t = setTimeout(refreshSessions, 250);
    return () => clearTimeout(t);
  }, [sessionSearch, refreshSessions]);

  useEffect(() => {
    window.voicecast.getBootstrap().then(setBoot).catch(console.error);
    const off = window.voicecast.onEvent((e) => {
      if (e.type === "state") setState(e.state);
      if (e.type === "session-error") setError(e.message);
      if (e.type === "agent-state") setGoalState(e.state);
    });
    window.voicecast.getState().then(setState);
    window.voicecast.agentGetState().then((s) => s && setGoalState(s)).catch(() => {});
    return off;
  }, []);

  const runGoal = useCallback(async () => {
    const text = goalText.trim();
    if (!text) return;
    setGoalBusy(true);
    try {
      const r = await window.voicecast.agentRunGoal(text);
      if (r.ok) setGoalText("");
      else setError(r.error);
    } finally {
      setGoalBusy(false);
    }
  }, [goalText]);

  const refreshScreens = useCallback(() => {
    window.voicecast.listSources("screen").then(setScreens).catch(console.error);
  }, []);
  const refreshWindows = useCallback(() => {
    window.voicecast.listSources("window").then(setWindows).catch(console.error);
  }, []);

  useEffect(() => {
    refreshScreens();
  }, [refreshScreens]);

  // Janelas: previews ao vivo SÓ com a tab delas aberta — cada tick de
  // getSources captura TODAS as janelas do desktop (main a ~25% de CPU com o
  // app parado quando isso rodava a cada 2.5s incondicionalmente).
  useEffect(() => {
    if (tab !== "window") return;
    refreshWindows();
    const iv = setInterval(refreshWindows, 2500);
    return () => clearInterval(iv);
  }, [tab, refreshWindows]);

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
    const sel = await window.voicecast.selectRegion();
    if (sel) setRegionRect(sel.rect);
    if (sel) setRegionDisplay(sel.displayIndex);
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

      {/* C4 — cockpit: goal digitado para o agente (estados ao vivo abaixo) */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="search"
          style={{ flex: 1, margin: 0 }}
          placeholder="Goal para o agente (ex.: resume as sessões de hoje)…"
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runGoal();
          }}
        />
        <button className="go" disabled={!goalText.trim() || goalBusy} onClick={() => void runGoal()}>
          ▶ Goal
        </button>
      </div>
      {goalState && (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          agente: <strong>{goalSummary(goalState)}</strong>
          {goalState.error ? ` — ${goalState.error}` : ""}
        </p>
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
              Overlays abrem em TODOS os monitores — arraste no que quiser e SOLTAR confirma (✕/Esc cancela).
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
                  onClick={() => void start({ mode: "region", rect: regionRect, displayIndex: regionDisplay })}
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

      <section className="library">
        <h2>
          Sessões{" "}
          <span className="muted">
            (
            {
              sessions.filter((s) =>
                typeFilter === "all"
                  ? true
                  : typeFilter === "ditado"
                    ? s.mode === "ditado"
                    : s.mode === typeFilter,
              ).length
            }
            )
          </span>
        </h2>
        <div className="tabs small">
          {(
            [
              ["all", "Todos"],
              ["ditado", "🎙 Ditados"],
              ["region", "▭ Regiões"],
              ["window", "🪟 Janelas"],
              ["screen", "🖥 Telas"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`tab ${typeFilter === id ? "on" : ""}`} onClick={() => setTypeFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="Buscar na fala das transcrições… (full-text)"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
        />
        <div className="lib-tools">
          <button
            onClick={() => void window.voicecast.openCorpus()}
            title="corrigir ditados do histórico (dataset de treino do voice — substitui o painel :8700)"
          >
            📚 dataset de treino
          </button>
        </div>
        <div className="grid sessions">
          {sessions
            .filter((s) =>
              typeFilter === "all"
                ? true
                : typeFilter === "ditado"
                  ? s.mode === "ditado"
                  : s.mode === typeFilter,
            )
            .slice(0, 12)
            .map((s) => {
              const d = s.startedAt ? new Date(s.startedAt) : null;
              const quando = d
                ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) +
                  " " +
                  d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
                : s.name;
              return (
                <button
                  key={`${s.dir}/${s.name}`}
                  className="card session"
                  title={`${s.dir} ${s.name} · ${s.status}${s.preview ? ` — ${s.preview}` : ""}`}
                  onClick={async () => {
                    await window.voicecast.openEditor(s.dir, s.name);
                  }}
                >
                  {s.thumb ? (
                    <img src={`file:///${s.thumb.replace(/\\/g, "/")}`} alt="" />
                  ) : s.mode === "ditado" ? (
                    <div className="nothumb ditado">🎙</div>
                  ) : (
                    <div className="nothumb" />
                  )}
                  <span className="sess-title">{s.title || `${s.name.slice(0, 4)} · ${s.mode ?? "?"}`}</span>
                  {s.preview && <span className="sess-preview">{s.preview}</span>}
                  <span className="sess-meta">
                    {quando} · {s.mode === "ditado" ? "ditado" : s.mode ?? "?"} ·{" "}
                    {s.transcriptStatus === "done"
                      ? "transcrito"
                      : s.transcriptStatus === "pending"
                        ? "transcrevendo…"
                        : s.status}
                  </span>
                </button>
              );
            })}
          {!sessions.length && (
            <p className="muted">
              {sessionSearch ? "Nada encontrado nessa busca." : "Nenhuma sessão gravada ainda."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
