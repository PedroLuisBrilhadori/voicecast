/**
 * Tela do dataset de treino do voice (W2a — issues #3+#5): lista, detalhe e
 * correção dos ditados do corpus histórico em
 * %LOCALAPPDATA%\voice-dictation\datasets\transcriptions — substitui o painel
 * :8700 aposentado com o daemon. Mesma operação do painel antigo: buscar,
 * abrir, apontar palavras erradas e rotular (bloco validation no JSON do
 * corpus; texto cru do ASR nunca é alterado).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatasetItemDetail, DatasetItemSummary, DatasetLabeledFilter } from "../shared/ipc";
import { wordsText } from "../shared/corrections";
import { WordFixer, diffWords, correctionMsg, fmt, type Word } from "./correction-ui";

const FILTERS: { key: DatasetLabeledFilter; label: string }[] = [
  { key: "any", label: "todas" },
  { key: "0", label: "sem correção" },
  { key: "1", label: "rotuladas" },
];

export function CorpusView({ initialId }: { initialId: string }) {
  const [items, setItems] = useState<DatasetItemSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [labeled, setLabeled] = useState<DatasetLabeledFilter>("any");
  const [detail, setDetail] = useState<DatasetItemDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const notify = useCallback((m: string) => {
    setStatus(m);
    setTimeout(() => setStatus(null), 6000);
  }, []);

  const loadList = useCallback(
    async (q: string, l: DatasetLabeledFilter) => {
      setItems(await window.voicecast.listDatasetItems(q, l));
    },
    [],
  );

  useEffect(() => {
    void loadList("", "any");
  }, [loadList]);

  const openItem = useCallback(async (id: string) => {
    setDetail(await window.voicecast.getDatasetItem(id));
  }, []);

  useEffect(() => {
    if (initialId) void openItem(initialId);
  }, [initialId, openItem]);

  const search = async () => void loadList(query, labeled);

  if (detail) {
    return (
      <CorpusDetail
        detail={detail}
        onBack={() => {
          setDetail(null);
          void loadList(query, labeled);
        }}
        notify={notify}
        onSaved={() => void openItem(detail.id)}
      />
    );
  }

  return (
    <div className="app corpus">
      <header className="ed-head">
        <button onClick={() => window.close()} title="fechar">✕</button>
        <h1 style={{ fontSize: 18, margin: 0 }}>Dataset do voice</h1>
        <span className="muted">
          {items ? `${items.length} itens (máx. 200)` : "carregando…"} ·{" "}
          %LOCALAPPDATA%\voice-dictation\datasets
        </span>
      </header>

      <div className="corp-tools">
        <input
          className="corp-search"
          placeholder="buscar no texto… (Enter)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
        />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={labeled === f.key ? "on" : ""}
            onClick={() => {
              setLabeled(f.key);
              void loadList(query, f.key);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="corp-list">
        {items?.length === 0 && <p className="muted">nada encontrado — dataset vazio ou ausente (fail-soft)</p>}
        {items?.map((it) => (
          <button key={it.id} className="corp-row" onClick={() => void openItem(it.id)}>
            <span className="mono">{it.id}</span>
            <span className="corp-preview">{it.preview || "(vazio)"}</span>
            {it.validated && <span className="ok" title="já rotulada">✓</span>}
            <span className="mono">{it.durationS != null ? `${it.durationS.toFixed(1)}s` : "?"}</span>
          </button>
        ))}
      </div>

      {status && <div className="status-bar">{status}</div>}
    </div>
  );
}

function CorpusDetail(props: {
  detail: DatasetItemDetail;
  onBack: () => void;
  notify: (m: string) => void;
  onSaved: () => void;
}) {
  const { detail, onBack, notify, onSaved } = props;
  const [fixing, setFixing] = useState(false);
  const [draft, setDraft] = useState<Word[] | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const words: Word[] = useMemo(() => detail.words ?? [], [detail]);
  const activeWord = useMemo(() => {
    if (!fixing) return words.findIndex((w) => time >= w.start && time < w.end);
    return -1; // em correção o destaque não persegue o playhead (evita re-render no input)
  }, [words, time, fixing]);

  const seek = (s: number) => {
    if (audioRef.current) audioRef.current.currentTime = s;
    setTime(s);
  };

  const startFix = () => {
    if (words.length) setDraft(words.map((w) => ({ ...w })));
    else setDraftText(detail.text);
    setFixing(true);
  };

  const cancelFix = () => {
    setFixing(false);
    setDraft(null);
    setDraftText(null);
  };

  const save = async () => {
    const edits = draft && words.length ? diffWords(words, draft) : [];
    const correctedText = draft ? wordsText(draft) : (draftText ?? "").replace(/\s+/g, " ").trim();
    if (!draft && !correctedText) return notify("correção vazia");
    const r = await window.voicecast.saveDatasetCorrection(detail.id, { correctedText, edits });
    notify(correctionMsg(r));
    if (r.ok) {
      cancelFix();
      onSaved();
    }
  };

  const v = detail.validation;
  const dur = detail.durationS ?? 0;

  return (
    <div className="app corpus">
      <header className="ed-head">
        <button onClick={onBack} title="voltar à lista">←</button>
        <h1 style={{ fontSize: 16, margin: 0 }} className="mono">{detail.id}</h1>
        <span className="tag">
          {detail.language ?? "?"} · {detail.model ?? "?"} · {dur.toFixed(1)}s ·{" "}
          {detail.source ?? "?"} · {detail.ts ?? "?"}
        </span>
        {v && (
          <span className="ok" title={`por ${v.labeled_by} em ${v.ts}`}>
            ✓ corrigida ({v.n_edits} edições)
          </span>
        )}
      </header>

      <main className="ed-main">
        <div className="ed-player">
          {detail.audioUrl ? (
            <audio
              ref={audioRef}
              src={detail.audioUrl}
              controls
              style={{ width: "100%" }}
              onTimeUpdate={(e) => setTime((e.target as HTMLAudioElement).currentTime)}
            />
          ) : (
            <p className="muted">wav ausente no raw/ (só texto)</p>
          )}
          {v && (
            <div className="corp-validation">
              <strong>texto corrigido:</strong> {v.corrected_text}
            </div>
          )}
        </div>

        <div className="ed-transcript">
          <div className="ed-transcript-head">
            <h3>Transcrição (crua do ASR — não é alterada)</h3>
            {words.length > 0 && <span className="muted">{words.length} palavras</span>}
            {!fixing && (
              <button onClick={startFix} title="apontar palavras erradas (rotula no corpus)">
                ✏️ corrigir
              </button>
            )}
            {fixing && (
              <>
                <button className="go" onClick={() => void save()}>💾 salvar correção</button>
                <button onClick={cancelFix}>cancelar</button>
              </>
            )}
          </div>

          {fixing && words.length > 0 && (
            <p className="muted" style={{ marginTop: 0 }}>
              clique na palavra errada, corrija e Enter — os timings são preservados
            </p>
          )}

          {fixing && words.length > 0 && <WordFixer words={draft!} activeIndex={activeWord} onChange={setDraft} />}

          {!fixing && words.length > 0 && (
            <p className="words">
              {words.map((w, i) => (
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

          {words.length === 0 && !fixing && <p className="muted">{detail.text}</p>}
          {fixing && words.length === 0 && (
            <textarea
              className="fix-text"
              value={draftText ?? ""}
              rows={8}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="texto corrigido (ditado sem words — correção é do texto inteiro)"
            />
          )}
        </div>
      </main>

      {status && <div className="status-bar">{status}</div>}
    </div>
  );
}
