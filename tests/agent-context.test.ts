/**
 * boundSessionContext (C3) — política de inclusão e truncamento do contexto
 * da última sessão, PURO (sem electron/fs). Idade, relevância Jev, política
 * conservadora sem Jev, truncamento em ~2k tokens na fronteira de
 * palavra/linha e sessão sem transcript.
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

/** Detail com idade exata (fim = startedAt + durationS) e sinais opcionais. */
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

describe("boundSessionContext — inclusão por idade e relevância", () => {
  it("sessão recente com relevância ≥ 2 → inclui o markdown", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 2.7 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("idade fora da janela de 30min → exclui", () => {
    expect(boundSessionContext(mk({ ageMin: 31, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 45, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("relevância < 2 → exclui (2.0 incluso na borda)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 1.9 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 2.0 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("env VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN encurta a janela", () => {
    process.env.VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN = "1";
    expect(boundSessionContext(mk({ ageMin: 2, relevancia: 3 }), { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(mk({ ageMin: 0.5, relevancia: 3 }), { markdown: MD, now: NOW })).toBe(MD);
  });

  it("idade conta do FIM da sessão (startedAt + durationS, como no hook C7)", () => {
    // startedAt há 70min + duração 60s → idade 69min (fora); com durationS
    // cobrindo, a mesma startedAt estaria na janela
    const startedAt = new Date(NOW - 70 * 60_000).toISOString();
    const fora = mk({ relevancia: 3, startedAt });
    expect(sessionAgeMin(fora, NOW)).toBeCloseTo(69, 5);
    expect(boundSessionContext(fora, { markdown: MD, now: NOW })).toBeNull();
  });

  it("skew de relógio (idade negativa) é aceito", () => {
    const futuro = mk({ relevancia: 3, startedAt: new Date(NOW + 10 * 60_000).toISOString() });
    expect(sessionAgeMin(futuro, NOW)).toBe(0);
    expect(boundSessionContext(futuro, { markdown: MD, now: NOW })).toBe(MD);
  });

  it("startedAt ausente/inválida → exclui (sem recência comprovável)", () => {
    const semData = { meta: { startedAt: null, durationS: DUR_S, jev: { relevancia: 3 } } };
    expect(boundSessionContext(semData, { markdown: MD, now: NOW })).toBeNull();
    const invalida = mk({ relevancia: 3, startedAt: "não-é-data" });
    expect(boundSessionContext(invalida, { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(null, { markdown: MD, now: NOW })).toBeNull();
    expect(boundSessionContext(undefined, { markdown: MD, now: NOW })).toBeNull();
  });
});

describe("boundSessionContext — política conservadora sem Jev", () => {
  it("Jev ausente + recentíssima (< 5min) com transcript → inclui", () => {
    const r = boundSessionContext(mk({ ageMin: 2, transcript: "fala da sessão" }), { markdown: MD, now: NOW });
    expect(r).toBe(MD);
  });

  it("Jev ausente + 10min → exclui (mesmo com transcript)", () => {
    expect(boundSessionContext(mk({ ageMin: 10, transcript: "fala" }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("Jev ausente + sem transcript → exclui (nada sinaliza conteúdo)", () => {
    expect(boundSessionContext(mk({ ageMin: 2 }), { markdown: MD, now: NOW })).toBeNull();
  });

  it("Jev ausente → freshMaxAgeMin é ajustável por opts", () => {
    const d = mk({ ageMin: 8, transcript: "fala" });
    expect(boundSessionContext(d, { markdown: MD, now: NOW, freshMaxAgeMin: 10 })).toBe(MD);
  });
});

describe("boundSessionContext — sessão sem transcript não quebra", () => {
  it("Jev ok + sem transcript → inclui o markdown (título/paths/julgamento)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 3 }), { markdown: MD, now: NOW })).toBe(MD);
    const transcriptNull = { ...mk({ ageMin: 5, relevancia: 3 }), transcript: null };
    expect(boundSessionContext(transcriptNull, { markdown: MD, now: NOW })).toBe(MD);
  });

  it("sem markdown montado → null (caller monta pelo buildContext)", () => {
    expect(boundSessionContext(mk({ ageMin: 5, relevancia: 3 }), { now: NOW })).toBeNull();
  });
});

describe("truncateToTokenBudget — truncamento OBRIGATÓRIO (~2k tokens)", () => {
  it("texto dentro do orçamento volta intacto (sem marcador)", () => {
    expect(truncateToTokenBudget("curto", 100)).toBe("curto");
  });

  it("corta na fronteira de PALAVRA (nunca no meio de uma palavra)", () => {
    const text = "word ".repeat(2000).trimEnd(); // 9999 chars
    const out = truncateToTokenBudget(text, SESSION_CONTEXT_MAX_TOKENS); // 8000 chars
    const content = out.replace("\n… (contexto truncado)", "");
    expect(out.endsWith("… (contexto truncado)")).toBe(true);
    expect(content.length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN);
    expect(content).toMatch(/word$/); // termina numa palavra completa
    expect(text.startsWith(content)).toBe(true); // prefixo do original
    expect(out).not.toBe(text); // nunca o transcript completo
  });

  it("prefere a fronteira de LINHA quando existe dentro da janela", () => {
    const text = `${"x".repeat(30)}\n${"y".repeat(30)}`;
    const out = truncateToTokenBudget(text, 10); // 40 chars
    expect(out).toBe("x".repeat(30) + "\n… (contexto truncado)");
    expect(out).not.toContain("yyy");
  });

  it("sem fronteira razoável → corte duro no limite", () => {
    const text = "z".repeat(100);
    const out = truncateToTokenBudget(text, 10); // 40 chars, sem espaço/linha
    expect(out.startsWith("z".repeat(40))).toBe(true);
    expect(out.endsWith("… (contexto truncado)")).toBe(true);
  });
});

describe("wrapSessionContextBlock — bloco delimitado", () => {
  it("delimitadores exatos do briefing", () => {
    expect(wrapSessionContextBlock(MD)).toBe(
      `${SESSION_CONTEXT_BEGIN}\n${MD}\n${SESSION_CONTEXT_END}`,
    );
    expect(wrapSessionContextBlock(MD)).toContain("--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---");
    expect(wrapSessionContextBlock(MD)).toContain("--- FIM DO CONTEXTO ---");
  });
});
