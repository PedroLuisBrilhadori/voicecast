import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail } from "../shared/ipc";

const params = new URLSearchParams(location.search);
const DIR = params.get("dir") ?? "";
const NAME = params.get("name") ?? "";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

type Word = { w: string; start: number; end: number; p: number };

/** Editor de sessão: player + transcrição sincronizada por palavra,
 *  clipes (I/O), prints e copiar contexto para o agente. */
export function EditorApp() {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<{ inS: number; outS: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.voicecast.getSession(DIR, NAME).then((d) => {
      if (d) {
        setDetail(d);
        setTitle(d.meta.title ?? "");
      }
    });
  }, []);

  // seek ← → highlight: o playhead manda no destaque
  const words: Word[] = useMemo(() => detail?.transcript?.words ?? [], [detail]);
  const activeWord = useMemo(() => {
    const i = words.findIndex((w) => time >= w.start && time < w.end);
    return i;
  }, [words, time]);

  useEffect(() => {
    if (activeWord < 0 || !transcriptRef.current) return;
    const el = transcriptRef.current.querySelector<HTMLElement>(`[data-wi="${activeWord}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeWord]);

  const seek = useCallback((s: number) => {
    if (videoRef.current) videoRef.current.currentTime = s;
    setTime(s);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const markIn = () => setSel({ inS: time, outS: sel?.outS ?? time + 5 });
  const markOut = () => setSel({ inS: sel?.inS ?? Math.max(0, time - 5), outS: time });

  const notify = (m: string) => {
    setStatus(m);
    setTimeout(() => setStatus(null), 4000);
  };

  const doClip = async () => {
    if (!sel) return;
    notify("gerando clipe…");
    const r = await window.voicecast.createClip(DIR, NAME, sel.inS, sel.outS, "trecho");
    if ("error" in r) notify(`clipe falhou: ${r.error}`);
    else notify(`clipe criado (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
  };

  const doFrame = async () => {
    const r = await window.voicecast.captureFrame(DIR, NAME, time);
    if ("error" in r) notify(`print falhou: ${r.error}`);
    else notify(`print salvo: ${r.file.split("\\").pop()}`);
  };

  const doContext = async () => {
    const r = await window.voicecast.buildContext(DIR, NAME, sel);
    if ("error" in r) return notify(r.error);
    await window.voicecast.copyText(r.markdown);
    notify("contexto copiado — cole no ZCode");
  };

  const saveTitle = async () => {
    await window.voicecast.updateSession(DIR, NAME, { title });
    notify("título salvo");
  };

  const retranscribe = async () => {
    notify("transcrevendo…");
    const r = await window.voicecast.transcribeSession(DIR, NAME);
    if (!r.ok) return notify(r.error);
    const d = await window.voicecast.getSession(DIR, NAME);
    setDetail(d);
    notify("transcrição pronta");
  };

  if (!detail) return <div className="app muted">carregando sessão…</div>;

  const t = detail.transcript;

  return (
    <div className="app editor">
      <header className="ed-head">
        <button onClick={() => window.close()} title="voltar">←</button>
        <input
          className="title-input"
          value={title}
          placeholder="título da sessão…"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
        />
        <span className="tag">
          {detail.meta.mode ?? "?"} · {fmt(detail.meta.durationS ?? 0)} ·{" "}
          {detail.meta.markers?.length ?? 0} markers
        </span>
        <button className="go big" onClick={doContext} title="Gera markdown com paths WSL e copia">
          ⧉ Copiar contexto p/ ZCode
        </button>
      </header>

      <main className="ed-main">
        <div className="ed-player">
          <video
            ref={videoRef}
            src={detail.videoUrl}
            onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
          <div className="ed-controls">
            <button onClick={togglePlay}>{playing ? "❚❚" : "▶"}</button>
            <span className="mono">{fmt(time)}</span>
            <input
              type="range"
              min={0}
              max={detail.meta.durationS ?? 0}
              step={0.1}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="mono">{fmt(detail.meta.durationS ?? 0)}</span>
          </div>
          <div className="ed-tools">
            <button onClick={markIn} disabled={!sel && time <= 0}>I marcar início</button>
            <button onClick={markOut}>O marcar fim</button>
            {sel && (
              <span className="tag">
                trecho {fmt(sel.inS)}–{fmt(sel.outS)}
              </span>
            )}
            <button onClick={doClip} disabled={!sel}>✂ criar clipe</button>
            <button onClick={doFrame}>📷 print do frame</button>
          </div>
        </div>

        <div className="ed-transcript" ref={transcriptRef}>
          <div className="ed-transcript-head">
            <h3>Transcrição</h3>
            {detail.meta.transcriptStatus !== "done" && (
              <button onClick={retranscribe}>
                {detail.meta.transcriptStatus === "pending" ? "transcrevendo…" : "transcrever agora"}
              </button>
            )}
            {t && (
              <span className="muted">
                {t.language ?? "?"} · {t.words.length} palavras
              </span>
            )}
          </div>
          {t && t.words.length > 0 && (
            <p className="words">
              {t.words.map((w, i) => (
                <span
                  key={i}
                  data-wi={i}
                  className={`w ${i === activeWord ? "on" : ""} ${w.p < 0.7 ? "low" : ""}`}
                  onClick={() => seek(w.start)}
                  title={`${fmt(w.start)} · conf ${Math.round(w.p * 100)}%`}
                >
                  {w.w}{" "}
                </span>
              ))}
            </p>
          )}
          {t && t.words.length === 0 && <p className="muted">{t.text}</p>}
          {!t && (
            <p className="muted">
              Sem transcrição ainda. {detail.meta.transcriptStatus === "sem-asr" && "ASR estava fora do ar quando a sessão terminou."}
            </p>
          )}

          {(detail.meta.markers?.length ?? 0) > 0 && (
            <>
              <h3>Markers</h3>
              <div className="markers">
                {detail.meta.markers!.map((m, i) => (
                  <button key={i} onClick={() => seek(m)}>
                    ◆ {fmt(m)}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="ed-foot">
            <button
              onClick={() => void window.voicecast.openPath(`C:\\Users\\pedro\\AppData\\Roaming\\voicecast\\sessions\\${DIR}\\${NAME}`)}
            >
              abrir pasta da sessão
            </button>
          </div>
        </div>
      </main>

      {status && <div className="status-bar">{status}</div>}
    </div>
  );
}
