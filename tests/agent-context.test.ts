/**
 * boundSessionContext (C3) — inclusion and truncation policy for the last
 * session context, PURE (no electron/fs). Age, Jev relevance, conservative
 * policy without Jev, ~2k token truncation at word/line boundary and session
 * without transcript.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  SESSION_CONTEXT_BEGIN,
  SESSION_CONTEXT_END,
  SESSION_CONTEXT_MAX_TOKENS,
  boundSessionContext,
  sessionAgeMin,
  truncateToTokenBudget,
  wrapSessionContextBlock,
} from "../src/shared/agent-context";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const DUR_S = 60;

/** Detail with exact age (end = startedAt + durationS) and optional signals. */
function mk(
  o: {
    ageMin?: number;
    relevancia?: number | null;
    transcript?: string | null;
    startedAt?: string;
  } = {},
) {
  const startedAt =
    o.startedAt ?? new Date(NOW - ((o.ageMin ?? 5) * 60 + DUR_S) * 1000).toISOString();
  return {
    meta: {
      startedAt,
      durationS: DUR_S,
      ...(o.relevancia !== undefined && o.relevancia !== null
        ? { jev: { relevancia: o.relevancia } }
        : {}),
    },
    ...(o.transcript !== undefined && o.transcript !== null
      ? { transcript: { text: o.transcript } }
      : {}),
  };
}

const MD = "### voicecast 2026-09-27 1010 (1:00) — Sessão\nFala (completa): \"olá mundo\"";

afterEach(() => {
  delete process.env.VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN;
});

describe("boundSessionContext — inclusion by age and relevance", () => {
  it("recent session with relevance ≥ 2 → includes the markdown", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 2.7 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("age outside the 30min window → excludes", () => {
    expect(boundSessionContext(mk({ ageMin: 31, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 45, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("relevance < 2 → excludes (2.0 included at the boundary)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 1.9 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 2.0 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("env VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN shortens the window", () => {
    process.env.VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN = "1";
    expect(boundSessionContext(mk({ ageMin: 2, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 0.5, relevancia: 3 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("age counts from the END of the session (startedAt + durationS, as in hook C7)", () => {
    // startedAt 70min ago + 60s duration → age 69min (out); with durationS
    // covered, the same startedAt would be inside the window
    const startedAt = new Date(NOW - 70 * 60_000).toISOString();
    const fora = mk({ relevancia: 3, startedAt });
    expect(sessionAgeMin(fora, NOW)).toBeCloseTo(69, 5);
    expect(boundSessionContext(fora, { markdown: MD, now: NOW })).toBeNull();
  });

  it("clock skew (negative age) is accepted", () => {
    const futuro = mk({ relevancia: 3, startedAt: new Date(NOW + 10 * 60_000).toISOString() });
    expect(sessionAgeMin(futuro, NOW)).toBe(0);
    expect(boundSessionContext(futuro, { markdown: MD, now: NOW })).toBe(MD);
  });

  it("missing/invalid startedAt → excludes (no provable recency)", () => {
    const semData = { meta: { startedAt: null, durationS: DUR_S, jev: { relevancia: 3 } } };
    expect(boundSessionContext(semData, { markdown: MD, now: NOW })).toBeNull();
    const invalida = mk({ relevancia: 3, startedAt: "não-é-data" });
    expect(boundSessionContext(invalida, { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(null, { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(undefined, { markdown: MD, now: NOW })).toBeNull();
  });
});

describe("boundSessionContext — conservative policy without Jev", () => {
  it("Jev absent + very recent (< 5min) with transcript → includes", () => {
    const r = boundSessionContext(mk({ ageMin: 2, transcript: "fala da sessão" }), { markdown: MD, now: NOW });
    expect(r).toBe(MD);
  });

  it("Jev absent + 10min → excludes (even with transcript)", () => {
    expect(boundSessionContext(mk({ ageMin: 10, transcript: "fala" }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("Jev absent + no transcript → excludes (nothing signals content)", () => {
    expect(boundSessionContext(mk({ ageMin: 2 }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("Jev absent → freshMaxAgeMin is adjustable via opts", () => {
    const d = mk({ ageMin: 8, transcript: "fala" });
    expect(boundSessionContext(d, { markdown: MD, now: NOW, freshMaxAgeMin: 10 })).toBe(MD);
  });
});

describe("boundSessionContext — session without transcript doesn't break", () => {
  it("Jev ok + no transcript → includes the markdown (title/paths/judgment)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 3 }), { markdown: MD, now: NOW })).toBe(MD);
    const transcriptNull = { ...mk({ ageMin: 5, relevancia: 3 }), transcript: null };
    expect(boundSessionContext(transcriptNull, { markdown: MD, now: NOW })).toBe(MD);
  });

  it("no assembled markdown → null (caller assembles it via buildContext)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 3 }), { now: NOW })).toBeNull();
  });
});

describe("truncateToTokenBudget — MANDATORY truncation (~2k tokens)", () => {
  it("text within budget comes back intact (no marker)", () => {
    expect(truncateToTokenBudget("curto", 100)).toBe("curto");
  });

  it("cuts at WORD boundary (never mid-word)", () => {
    const text = "word ".repeat(2000).trimEnd(); // 9999 chars
    const out = truncateToTokenBudget(text, SESSION_CONTEXT_MAX_TOKENS); // 8000 chars
    const content = out.replace("\n… (context truncated)", "");
    expect(out.endsWith("… (context truncated)")).toBe(true);
    expect(content.length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN);
    expect(content).toMatch(/word$/); // ends on a complete word
    expect(text.startsWith(content)).toBe(true); // prefix of the original
    expect(out).not.toBe(text); // never the full transcript
  });

  it("prefers the LINE boundary when one exists inside the window", () => {
    const text = `${"x".repeat(30)}\n${"y".repeat(30)}`;
    const out = truncateToTokenBudget(text, 10); // 40 chars
    expect(out).toBe("x".repeat(30) + "\n… (context truncated)");
    expect(out).not.toContain("yyy");
  });

  it("no reasonable boundary → hard cut at the limit", () => {
    const text = "z".repeat(100);
    const out = truncateToTokenBudget(text, 10); // 40 chars, no space/line
    expect(out.startsWith("z".repeat(40))).toBe(true);
    expect(out.endsWith("… (context truncated)")).toBe(true);
  });
});

describe("wrapSessionContextBlock — delimited block", () => {
  it("exact briefing delimiters", () => {
    expect(wrapSessionContextBlock(MD)).toBe(
      `${SESSION_CONTEXT_BEGIN}\n${MD}\n${SESSION_CONTEXT_END}`,
    );
    expect(wrapSessionContextBlock(MD)).toContain("--- LAST SESSION CONTEXT (auto) ---");
    expect(wrapSessionContextBlock(MD)).toContain("--- END OF CONTEXT ---");
  });
});
