/**
 * UI de correção de ditados (W2a) — peças compartilhadas entre o editor de
 * sessão (EditorApp) e a tela do dataset do voice (CorpusView).
 */
import { useState } from "react";
import type { CorrectionEdit } from "../shared/ipc";

export type Word = { w: string; start: number; end: number; p: number };

/** fmt mm:ss local (mesmo formato do editor). */
export function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Diff palavra a palavra entre o original e o rascunho editado. */
export function diffWords(original: Word[], draft: Word[]): CorrectionEdit[] {
  const edits: CorrectionEdit[] = [];
  for (let i = 0; i < Math.min(original.length, draft.length); i++) {
    if (original[i].w !== draft[i].w) {
      edits.push({ index: i, originalW: original[i].w, correctedW: draft[i].w });
    }
  }
  return edits;
}

/**
 * Transcrição por palavra em modo correção: clique numa palavra → input inline;
 * Enter/blur confirma (preserva start/end/p — só o texto muda), Esc cancela.
 * `activeIndex` destaca a palavra do playhead (como fora do modo correção).
 */
export function WordFixer(props: {
  words: Word[];
  activeIndex?: number;
  onChange: (next: Word[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const { words, activeIndex, onChange } = props;

  const commit = (i: number, value: string) => {
    const v = value.replace(/\s+/g, " ").trim();
    setEditing(null);
    if (!v || v === words[i].w) return;
    onChange(words.map((w, j) => (j === i ? { ...w, w: v } : w)));
  };

  return (
    <p className="words fixing">
      {words.map((w, i) =>
        editing === i ? (
          <input
            key={i}
            className="fix-input"
            data-wi={i}
            autoFocus
            defaultValue={w.w}
            style={{ width: `${Math.max(3, w.w.length + 1)}ch` }}
            onBlur={(e) => commit(i, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <span
            key={i}
            data-wi={i}
            className={`w ${i === activeIndex ? "on" : ""} ${w.p < 0.7 ? "low" : ""}`}
            onClick={() => setEditing(i)}
            title={`${fmt(w.start)} · conf ${Math.round(w.p * 100)}% · clique p/ corrigir`}
          >
            {w.w}{" "}
          </span>
        ),
      )}
    </p>
  );
}

/** Mensagem de desfecho da correção — sinaliza o que foi gravado (alvo/dataset). */
export function correctionMsg(r: { ok: boolean; alvo?: string; dataset?: string; error?: string }): string {
  if (!r.ok) return `correção falhou: ${r.error ?? "?"}`;
  if (r.alvo === "ambos") return "correção gravada no voicecast e no dataset do voice";
  if (r.alvo === "dataset") return "correção gravada no dataset do voice";
  if (r.dataset === "ausente") {
    return "correção gravada no voicecast (dataset do voice não encontrado — fail-soft)";
  }
  if (r.dataset === "erro") {
    return "correção gravada no voicecast (dataset falhou — nada foi truncado)";
  }
  return "correção gravada no voicecast";
}
