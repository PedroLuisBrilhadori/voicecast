import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipInfo, CorrectionResult, SessionDetail, SessionSegment } from "../shared/ipc";
import { newSegmentId } from "../shared/segments";
import { wordsText } from "../shared/corrections";
import { CorpusView } from "./CorpusView";
import { WordFixer, correctionMsg, diffWords, fmt, type Word } from "./correction-ui";

const params = new URLSearchParams(location.search);
const DIR = params.get("dir") ?? "";
const NAME = params.get("name") ?? "";
/** W2a: ?corpus (or ?corpus=<id>) opens the voice dataset screen instead of the editor. */
const CORPUS = params.get("corpus");

/** Session editor: player + word-synced transcript,
 *  named segments (phase B), clips, screenshots and copy context for the agent. */
export function EditorApp() {
  // W2a: voice dataset window (historical corpus list/detail/correction)
  if (CORPUS !== null) return <CorpusView initialId={CORPUS} />;
  return <SessionEditor />;
}

function SessionEditor() {
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
  // ── dictation correction (W2a): edit words preserving timings ──
  const [fixing, setFixing] = useState(false);
  const [fixText, setFixText] = useState(false);
  const [draftWords, setDraftWords] = useState<Word[] | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);

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

  // seek ← → highlight: the playhead drives the highlight
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

  // ── segments (phase B): source of truth is meta.json (main sanitizes) ──

  const persistSegments = useCallback(async (next: SessionSegment[]) => {
    setSegments(next);
    await window.voicecast.updateSession(DIR, NAME, { segments: next });
  }, []);

  const addSeg = () => {
    if (!sel) return;
    const seg: SessionSegment = {
      id: newSegmentId(),
      label: `Segment ${segments.length + 1}`,
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
    notify(`generating clip of "${s.label}"…`);
    const r = await window.voicecast.createClip(DIR, NAME, s.inS, s.outS, s.label);
    if ("error" in r) notify(`clip failed: ${r.error}`);
    else {
      notify(`clip created (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
  };

  const doCut = async () => {
    if (!segments.length) return;
    notify(`generating cut of ${segments.length} segments…`);
    const r = await window.voicecast.exportCut(DIR, NAME, segments, "corte");
    if ("error" in r) notify(`cut failed: ${r.error}`);
    else {
      notify(`cut ready (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
  };

  const doClip = async () => {
    if (!sel) return;
    notify("generating clip…");
    const r = await window.voicecast.createClip(DIR, NAME, sel.inS, sel.outS, "trecho");
    if ("error" in r) notify(`clip failed: ${r.error}`);
    else {
      notify(`clip created (${(r.bytes / 1_048_576).toFixed(1)}MB)`);
      void refreshClips();
    }
  };

  const doFrame = async () => {
    const r = await window.voicecast.captureFrame(DIR, NAME, time);
    if ("error" in r) notify(`screenshot failed: ${r.error}`);
    else notify(`screenshot saved: ${r.file.split("\\").pop()}`);
  };

  const doContext = async () => {
    const r = await window.voicecast.buildContext(DIR, NAME, sel);
    if ("error" in r) return notify(r.error);
    await window.voicecast.copyText(r.markdown);
    notify("context copied — paste it into ZCode");
  };

  const saveTitle = async () => {
    await window.voicecast.updateSession(DIR, NAME, { title });
    notify("title saved");
  };

  const doCopyText = async () => {
    if (!t) return;
    const text = t.text.trim();
    if (!text) return notify("nothing to copy");
    await window.voicecast.copyText(text);
    notify(`text copied (${text.length} chars) — paste it anywhere`);
  };

  const retranscribe = async () => {
    notify("transcribing…");
    const r = await window.voicecast.transcribeSession(DIR, NAME);
    if (!r.ok) return notify(r.error);
    const d = await window.voicecast.getSession(DIR, NAME);
    if (d) {
      setDetail(d);
      setSegments(d.meta.segments ?? []);
    }
    notify("transcription ready");
  };

  // ── dictation correction (W2a): words editable in place; plain text when
  //    words is empty (fake-hook/old dictations). Targets: transcript.json +
  //    meta.json always; voice dataset when the session has datasetId. ──

  const startFix = () => {
    if (fixText || !t?.words.length) setDraftText(t?.text ?? "");
    else setDraftWords(t.words.map((w) => ({ ...w })));
    setFixing(true);
  };

  const cancelFix = () => {
    setFixing(false);
    setFixText(false);
    setDraftWords(null);
    setDraftText(null);
  };

  const saveFix = async () => {
    let req: { correctedText: string; edits: ReturnType<typeof diffWords> };
    if (draftWords && t?.words.length && !fixText) {
      req = { correctedText: wordsText(draftWords), edits: diffWords(t.words, draftWords) };
    } else {
      const corrected = (draftText ?? "").replace(/\s+/g, " ").trim();
      if (!corrected) return notify("empty correction");
      // full rewrite: the engine replaces the transcript text; on the dataset
      // it goes as validation with n_edits = word diff (words lose the 1:1
      // timing alignment — accepted trade-off of text mode)
      req = { correctedText: corrected, edits: [] };
    }
    const r: CorrectionResult = await window.voicecast.saveCorrection(DIR, NAME, req);
    notify(correctionMsg(r));
    if (r.ok) {
      cancelFix();
      const d = await window.voicecast.getSession(DIR, NAME);
      if (d) setDetail(d);
    }
  };

  if (!detail) return <div className="app muted">loading session…</div>;

  const t = detail.transcript;
  const isAudio = detail.mediaKind === "audio";
  const dur = detail.meta.durationS ?? 0;
  const pct = (s: number) => (dur > 0 ? Math.min(100, (s / dur) * 100) : 0);

  return (
    <div className="app editor">
      <header className="ed-head">
        <button onClick={() => window.close()} title="back">←</button>
        <input
          className="title-input"
          value={title}
          placeholder="session title…"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
        />
        <span className="tag">
          {detail.meta.mode === "ditado" ? "🎙 dictation" : detail.meta.mode ?? "?"} ·{" "}
          {fmt(dur)} · {detail.meta.markers?.length ?? 0} markers
        </span>
        <button className="go big" onClick={doContext} title="Generates markdown with WSL paths and copies it">
          ⧉ Copy context to ZCode
        </button>
        <button onClick={() => void window.voicecast.openCorpus()} title="correct historical dictations (voice dataset)">
          📚 dataset
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
              {/* segment timeline: block = named segment; ghost green = current I/O selection */}
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
                    title={`${s.label} · ${fmt(s.inS)}–${fmt(s.outS)} (click to play)`}
                  />
                ))}
              </div>
              <div className="ed-tools">
                <button onClick={markIn} disabled={!sel && time <= 0}>I mark in</button>
                <button onClick={markOut}>O mark out</button>
                {sel && (
                  <span className="tag">
                    selection {fmt(sel.inS)}–{fmt(sel.outS)}
                  </span>
                )}
                <button onClick={addSeg} disabled={!sel} title="Saves the I/O selection as a named segment">
                  ＋ segment
                </button>
                <button onClick={doClip} disabled={!sel}>✂ clip selection</button>
                <button onClick={doFrame}>📷 frame screenshot</button>
              </div>
            </>
          )}
        </div>

        <div className="ed-transcript" ref={transcriptRef}>
          <div className="ed-transcript-head">
            <h3>Transcription</h3>
            {detail.meta.transcriptStatus !== "done" && (
              <button onClick={retranscribe}>
                {detail.meta.transcriptStatus === "pending" ? "transcribing…" : "transcribe now"}
              </button>
            )}
            {t && (
              <span className="muted">
                {t.language ?? "?"} · {t.words.length} words
              </span>
            )}
            {detail.meta.correction && (
              <span className="ok" title={`corrected at ${detail.meta.correction.correctedAt}`}>
                ✓ corrected ({detail.meta.correction.nEdits} edits
                {detail.meta.correction.dataset === "ok" ? " · dataset" : ""})
              </span>
            )}
            {t && !fixing && detail.meta.mode === "ditado" && (
              <>
                <button onClick={startFix} title="edit wrong words in place (timings preserved; dataset when linked)">
                  ✏️ correct
                </button>
                {t.words.length > 0 && (
                  <button
                    onClick={() => {
                      setFixText(true);
                      startFix();
                    }}
                    title="rewrite the full text (the engine reapplies it; approximate timings)"
                  >
                    ✍️ rewrite text
                  </button>
                )}
              </>
            )}
            {fixing && (
              <>
                <button className="go" onClick={() => void saveFix()}>💾 save correction</button>
                <button onClick={cancelFix}>cancel</button>
              </>
            )}
            {t && t.text.trim() && (
              <button className="copy-text" onClick={doCopyText} title="copy only the transcript text">
                📋 copy text
              </button>
            )}
          </div>
          {fixing && t && t.words.length > 0 && !fixText && (
            <p className="muted" style={{ marginTop: 0 }}>
              click the wrong word, fix it, press Enter — timings are preserved
            </p>
          )}
          {fixing && t && t.words.length > 0 && !fixText && (
            <WordFixer words={draftWords ?? []} activeIndex={-1} onChange={setDraftWords} />
          )}
          {fixing && fixText && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                rewrite the whole text — timings are redistributed over the original speech
              </p>
              <textarea
                className="fix-text"
                value={draftText ?? ""}
                rows={8}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="full corrected text"
              />
            </>
          )}
          {fixing && t && t.words.length === 0 && (
            <textarea
              className="fix-text"
              value={draftText ?? ""}
              rows={8}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="corrected text (dictation without words — the whole text is corrected)"
            />
          )}
          {!fixing && t && t.words.length > 0 && (
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
          {!fixing && t && t.words.length === 0 && <p className="muted">{t.text}</p>}
          {!t && (
            <p className="muted">
              No transcript yet. {detail.meta.transcriptStatus === "sem-asr" && "ASR was down when the session ended."}
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
              <h3>Segments ({segments.length})</h3>
              <div className="seg-list">
                {segments.map((s) => (
                  <div key={s.id} className="seg-row">
                    <button onClick={() => playSeg(s)} title="play from segment start">▶</button>
                    <input
                      value={s.label}
                      maxLength={80}
                      onChange={(e) => renameSeg(s.id, e.target.value)}
                      onBlur={() => commitRename(s.id)}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                    <span className="tag mono">{fmt(s.inS)}–{fmt(s.outS)}</span>
                    <button onClick={() => void segClip(s)} title="generate mp4 clip of the segment">✂</button>
                    <button onClick={() => rmSeg(s.id)} title="remove segment">✕</button>
                  </div>
                ))}
              </div>
              <button className="go" onClick={doCut} title="Concatenates all segments into a single mp4">
                ⧉ export cut ({segments.length} segments)
              </button>
            </>
          )}

          <h3>Clips</h3>
          <div className="clip-list">
            {clips.length === 0 && (
              <p className="muted">no clips yet — mark I/O and cut (or use the segments)</p>
            )}
            {clips.map((c) => (
              <button
                key={c.file}
                className="clip-row"
                onClick={() => void window.voicecast.openPath(c.file)}
                title="show in explorer"
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
              open session folder
            </button>
          </div>
        </div>
      </main>

      {status && <div className="status-bar">{status}</div>}
    </div>
  );
}
