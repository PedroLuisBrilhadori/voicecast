import { useCallback, useEffect, useState } from "react";
import type { AsrHostStatus, Bootstrap, RecordingState, SessionSummary, SourceInfo, StartRecordingRequest } from "../shared/ipc";
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
  // C4 — cockpit: typed goal input (voice comes later — F9 already routes it)
  const [goalText, setGoalText] = useState("");
  const [goalState, setGoalState] = useState<GoalState | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  // transcription model switch (local ASR) — settings.json
  const [asr, setAsr] = useState<AsrHostStatus | null>(null);

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

  // full-text search debounce
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
    window.voicecast.asrHostGet().then(setAsr).catch(() => {});
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

  // Windows: live previews ONLY while their tab is open — every getSources
  // tick captures ALL desktop windows (main sat at ~25% CPU with the app idle
  // when this ran unconditionally every 2.5s).
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
        if (!res.ok) setError(res.error ?? "failed to start");
        else window.close(); // recording started: panel hides, bar stays
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
            <span className="tag rec-live">● {state.phase === "processing" ? "processing" : "REC"}</span>
          )}
        </h1>
        <p className="sub">
          Record voice + screen, transcribe locally, and turn it into context for the agent.{" "}
          <kbd>{boot?.shortcuts.togglePanel ?? "Ctrl+F9"}</kbd> toggles this panel ·{" "}
          <kbd>{boot?.shortcuts.recordFullscreen ?? "Ctrl+Shift+F9"}</kbd> records the whole screen right away.
        </p>
      </header>

      {error && (
        <div className="error-bar">
          {error} <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* C4 — cockpit: goal typed for the agent (live states below) */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="search"
          style={{ flex: 1, margin: 0 }}
          placeholder="Goal for the agent (e.g.: summarize today's sessions)…"
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
          agent: <strong>{goalSummary(goalState)}</strong>
          {goalState.error ? ` — ${goalState.error}` : ""}
        </p>
      )}

      <div className="tabs">
        {(
          [
            ["screen", "🖥 Full screen"],
            ["window", "🪟 Window"],
            ["region", "▭ Region"],
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
            {!screens.length && <p className="muted">No screens detected yet…</p>}
          </div>
        )}

        {tab === "window" && (
          <>
            <input
              className="search"
              placeholder="Search windows…"
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
              {!filteredWindows.length && <p className="muted">No window with that name.</p>}
            </div>
          </>
        )}

        {tab === "region" && (
          <div className="region-pane">
            <button className="big" disabled={recording || busy} onClick={() => void pickRegion()}>
              ▭ Select area on screen
            </button>
            <p className="muted">
              Overlays open on ALL monitors — drag on whichever you want and RELEASING confirms (✕/Esc cancels).
            </p>
            {regionRect ? (
              <div className="region-summary">
                <span>
                  Selected: <strong>{regionRect.width}×{regionRect.height}</strong> px
                </span>
                <button className="go" disabled={recording || busy} onClick={() => void pickRegion()}>
                  Re-select
                </button>
                <button
                  className="go big"
                  disabled={recording || busy}
                  onClick={() => void start({ mode: "region", rect: regionRect, displayIndex: regionDisplay })}
                >
                  ● Record region
                </button>
              </div>
            ) : (
              <p className="muted">Nothing selected yet.</p>
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
          🎙 microphone
        </label>

        <label
          className="mic"
          title={
            asr?.source === "env"
              ? "disabled via env (VOICECAST_ASR_HOST=0) — settings cannot enable it"
              : asr?.enabled
                ? "local transcription model enabled (settings.json asrHost)"
                : "local transcription model DISABLED — dictation/sessions get no speech"
          }
        >
          <input
            type="checkbox"
            checked={asr?.enabled ?? true}
            disabled={!asr || asr.source === "env"}
            onChange={(e) => {
              const on = e.target.checked;
              setAsr(on ? { enabled: true, source: "settings", external: asr?.external ?? false, hosted: asr?.hosted ?? false } : { enabled: false, source: "settings", external: asr?.external ?? false, hosted: false });
              window.voicecast.asrHostSet(on).then((r) => r.ok && setAsr(r.status)).catch(() => {});
            }}
          />
          🗣 transcription{asr && !asr.enabled ? " (off)" : ""}
        </label>

        {tab === "screen" && (
          <button
            className="big go"
            disabled={!screens.length || recording || busy}
            onClick={() => void start({ mode: "screen", sourceId: screens[0]?.id })}
          >
            ● Record screen
          </button>
        )}
        {tab === "window" && (
          <p className="muted" style={{ margin: 0 }}>
            Click the desired window above to record it.
          </p>
        )}
      </footer>

      <section className="library">
        <h2>
          Sessions{" "}
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
              ["all", "All"],
              ["ditado", "🎙 Dictations"],
              ["region", "▭ Regions"],
              ["window", "🪟 Windows"],
              ["screen", "🖥 Screens"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`tab ${typeFilter === id ? "on" : ""}`} onClick={() => setTypeFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="Search transcript speech… (full-text)"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
        />
        <div className="lib-tools">
          <button
            onClick={() => void window.voicecast.openCorpus()}
            title="correct historical dictations (voice training dataset — replaces the :8700 panel)"
          >
            📚 training dataset
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
                    {quando} · {s.mode === "ditado" ? "dictation" : s.mode ?? "?"} ·{" "}
                    {s.transcriptStatus === "done"
                      ? "transcribed"
                      : s.transcriptStatus === "pending"
                        ? "transcribing…"
                        : s.status}
                  </span>
                </button>
              );
            })}
          {!sessions.length && (
            <p className="muted">
              {sessionSearch ? "Nothing found for this search." : "No sessions recorded yet."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
