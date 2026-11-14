/**
 * Dictation correction UI (W2a) — pieces shared between the session editor
 * (EditorApp) and the voice dataset screen (CorpusView).
 */
import { useState } from "react";
import type { CorrectionEdit } from "../shared/ipc";

export type Word = { w: string; start: number; end: number; p: number };

/** Local mm:ss fmt (same format as the editor). */
export function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Word-by-word diff between the original and the edited draft. */
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
 * Word-by-word transcript in correction mode: click a word → inline input;
 * Enter/blur confirms (preserves start/end/p — only the text changes), Esc cancels.
 * `activeIndex` highlights the playhead's word (like outside correction mode).
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
            title={`${fmt(w.start)} · conf ${Math.round(w.p * 100)}% · click to correct`}
          >
            {w.w}{" "}
          </span>
        ),
      )}
    </p>
  );
}

/** Correction outcome message — signals what was saved (target/dataset). */
export function correctionMsg(r: { ok: boolean; alvo?: string; dataset?: string; error?: string }): string {
  if (!r.ok) return `correction failed: ${r.error ?? "?"}`;
  if (r.alvo === "ambos") return "correction saved to voicecast and the voice dataset";
  if (r.alvo === "dataset") return "correction saved to the voice dataset";
  if (r.dataset === "ausente") {
    return "correction saved to voicecast (voice dataset not found — fail-soft)";
  }
  if (r.dataset === "erro") {
    return "correction saved to voicecast (dataset failed — nothing was truncated)";
  }
  return "correction saved to voicecast";
}
