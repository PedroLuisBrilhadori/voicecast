import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipInfo, SessionDetail, SessionSegment } from "../shared/ipc";
import { newSegmentId } from "../shared/segments";

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
 *  segmentos nomeados (fase B), clipes, prints e copiar contexto p/ agente. */
export function EditorApp() {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<{ inS: number; outS: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [segments, setSegments] = useState<SessionSegment[]>([]);
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const refreshClips = useCallback(async () => {
    setClips(await window.voicecast.listClips(DIR, NAME));
  }, []);

  useEffect(() => {
    window.voicecast.getSession(DIR, NAME).then((d) => {
      if (d) {
        setDetail(d);
        setTitle(d.meta.title ?? "");
        setSegments(d.meta.segments ?? []);
      }
    });
    void refreshClips();
  }, [refreshClips]);

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

  // ── segmentos (fase B): fonte da verdade é o meta.json (main sanitiza) ──

  const persistSegments = useCallback(async (next: SessionSegment[]) => {
    setSegments(next);
    await window.voicecast.updateSession(DIR, NAME, { segments: next });
  }, []);

  const addSeg = () => {
    if (!sel) return;
    const seg: SessionSegment = {
      id: newSegmentId(),
      label: `Segmento ${segments.length + 1}`,
      inS: +sel.inS.toFixed(2),
      outS: +sel.outS.toFixed(2),
    };
    void persistSegments([...segments, seg]);
    setSel(null);
  };

  const rmSeg = (id: string) => void persistSegments(segments.filter((s) => s.id !== id));

  const renameSeg = (id: string, label: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)));
  };

  const commitRename = (id: string) => {
    const seg = segments.find((s) => s.id === id);
    if (seg) void persistSegments(segments);
  };

  const playSeg = (s: SessionSegment) => {
    seek(s.inS);
    void videoRef.current?.play();
  };

  const segClip = async (s: SessionSegment) => {
    notify(`gerando clipe de "${s.label}"…`);
    const r = await window.voicecast.createClip(DIR, NAME, s.inS, s.outS, s.label);
    if ("error" in r) notify(`clipe falhou: ${r.error}`);
    else {
      notify(`clipe criado (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
  };

  const doCut = async () => {
    if (!segments.length) return;
    notify(`gerando corte de ${segments.length} trechos…`);
    const r = await window.voicecast.exportCut(DIR, NAME, segments, "corte");
    if ("error" in r) notify(`corte falhou: ${r.error}`);
    else {
      notify(`corte pronto (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
  };

  const doClip = async () => {
    if (!sel) return;
    notify("gerando clipe…");
    const r = await window.voicecast.createClip(DIR, NAME, sel.inS, sel.outS, "trecho");
    if ("error" in r) notify(`clipe falhou: ${r.error}`);
    else {
      notify(`clipe criado (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
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
    if (d) {
      setDetail(d);
      setSegments(d.meta.segments ?? []);
    }
    notify("transcrição pronta");
  };

  if (!detail) return <div className="app muted">carregando sessão…</div>;

  const t = detail.transcript;
  const isAudio = detail.mediaKind === "audio";
  const dur = detail.meta.durationS ?? 0;
  const pct = (s: number) => (dur > 0 ? Math.min(100, (s / dur) * 100) : 0);

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
          {detail.meta.mode === "ditado" ? "🎙 ditado" : detail.meta.mode ?? "?"} ·{" "}
          {fmt(dur)} · {detail.meta.markers?.length ?? 0} markers
        </span>
        <button className="go big" onClick={doContext} title="Gera markdown com paths WSL e copia">
          ⧉ Copiar contexto p/ ZCode
        </button>
      </header>

      <main className="ed-main">
        <div className="ed-player">
          {detail.mediaUrl && isAudio && <audio ref={videoRef as never} src={detail.mediaUrl} controls style={{ width: "100%" }} />}
          {detail.mediaUrl && !isAudio && (
            <video
              ref={videoRef}
              src={detail.mediaUrl}
              onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
            />
          )}
          <div className="ed-controls">
            {!isAudio && <button onClick={togglePlay}>{playing ? "❚❚" : "▶"}</button>}
            <span className="mono">{fmt(time)}</span>
            <input
              type="range"
              min={0}
              max={dur}
              step={0.1}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="mono">{fmt(dur)}</span>
          </div>
          {!isAudio && (
            <>
              {/* timeline de segmentos: bloco = trecho nomeado; verde fantasma = seleção I/O corrente */}
              <div className="seg-track">
                {sel && (
                  <span
                    className="seg-block ghost"
                    style={{ left: `${pct(sel.inS)}%`, width: `${pct(sel.outS) - pct(sel.inS)}%` }}
                  />
                )}
                {segments.map((s) => (
                  <button
                    key={s.id}
                    className="seg-block"
                    style={{ left: `${pct(s.inS)}%`, width: `${pct(s.outS) - pct(s.inS)}%` }}
                    onClick={() => playSeg(s)}
                    title={`${s.label} · ${fmt(s.inS)}–${fmt(s.outS)} (clique p/ tocar)`}
                  />
                ))}
              </div>
              <div className="ed-tools">
                <button onClick={markIn} disabled={!sel && time <= 0}>I marcar início</button>
                <button onClick={markOut}>O marcar fim</button>
                {sel && (
                  <span className="tag">
                    trecho {fmt(sel.inS)}–{fmt(sel.outS)}
                  </span>
                )}
                <button onClick={addSeg} disabled={!sel} title="Salva o trecho I/O como segmento nomeado">
                  ＋ segmento
                </button>
                <button onClick={doClip} disabled={!sel}>✂ clipe do trecho</button>
                <button onClick={doFrame}>📷 print do frame</button>
              </div>
            </>
          )}
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

          {!isAudio && segments.length > 0 && (
            <>
              <h3>Segmentos ({segments.length})</h3>
              <div className="seg-list">
                {segments.map((s) => (
                  <div key={s.id} className="seg-row">
                    <button onClick={() => playSeg(s)} title="tocar do início do trecho">▶</button>
                    <input
                      value={s.label}
                      maxLength={80}
                      onChange={(e) => renameSeg(s.id, e.target.value)}
                      onBlur={() => commitRename(s.id)}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                    <span className="tag mono">{fmt(s.inS)}–{fmt(s.outS)}</span>
                    <button onClick={() => void segClip(s)} title="gerar clipe mp4 do trecho">✂</button>
                    <button onClick={() => rmSeg(s.id)} title="remover segmento">✕</button>
                  </div>
                ))}
              </div>
              <button className="go" onClick={doCut} title="Concatena todos os trechos num mp4 único">
                ⧉ exportar corte ({segments.length} trechos)
              </button>
            </>
          )}

          <h3>Clipes</h3>
          <div className="clip-list">
            {clips.length === 0 && (
              <p className="muted">nenhum clipe ainda — marque I/O e recorte (ou use os segmentos)</p>
            )}
            {clips.map((c) => (
              <button
                key={c.file}
                className="clip-row"
                onClick={() => void window.voicecast.openPath(c.file)}
                title="mostrar no explorer"
              >
                <span className="mono">{c.name}</span>
                <span className="muted">{(c.bytes / 1_048_576).toFixed(1)}MB</span>
              </button>
            ))}
          </div>

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
