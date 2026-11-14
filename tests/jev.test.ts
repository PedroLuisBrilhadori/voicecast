/**
 * Tests of the Jev module (src/main/jev.ts) — no network: the SDK accepts an
 * injectable fetch (judgeDictation/judgeSession expose the parameter), and the
 * fixtures mirror real API responses (probe 2026-09-21, docs/RELATORIO-E1.md).
 * decidePaste is the heart of F9: the truth table below is the UX contract.
 */
import { describe, expect, it } from "vitest";
import { decidePaste, jevJudge, judgeDictation, judgeSession, type DictationJudgment } from "../src/main/jev";
import { AUTO_CONFIDENCE, Q_PEDIDO, Q_RELEVANCIA, Q_RISCO, Q_ROTA, ROTAS } from "../src/main/jev-questions";

process.env.TYPESAFE_API_KEY = "test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Real response (probe): choice with 4 options. */
const FIX_ROTA = {
  model: "jev-1.13.0",
  answers: {
    rota: {
      type: "choice",
      choice: "comando_agente",
      confidence: 0.98,
      probabilities: { comando_agente: 0.98, conversa_social: 0.01, anotacao_contexto: 0.01, ditado_texto: 0 },
    },
  },
  usage: { input_tokens: 300, output_tokens: 30 },
};

/** Real response (probe): the session's 4 questions. */
const FIX_SESSAO = {
  model: "jev-1.13.0",
  answers: {
    rota: { type: "choice", choice: "comando_agente", confidence: 0.98, probabilities: {} },
    relevancia: { type: "score", score: 2.92, confidence: 0.92, legend: {}, probabilities: {} },
    pedido: { type: "noul", noul: 0.98 },
    risco: { type: "noul", noul: 0.97 },
  },
  usage: { input_tokens: 815, output_tokens: 120 },
};

function captureFetch(body: unknown, capture?: { url?: string; body?: any }) {
  return async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(String(init?.body ?? "{}"));
    }
    return jsonResponse(body);
  };
}

describe("questions (jev-questions)", () => {
  it("ROTA choice options are exactly the ROTAS — decidePaste depends on them", () => {
    expect(Q_ROTA.type).toBe("choice");
    expect(Object.keys(Q_ROTA.criteria)).toEqual([...ROTAS]);
  });
  it("correct primitives in the session", () => {
    expect(Q_RELEVANCIA.type).toBe("score");
    expect(Q_PEDIDO.type).toBe("noul");
    expect(Q_RISCO.type).toBe("noul");
  });
});

describe("judgeDictation (F9)", () => {
  it("maps the response to route+confidence", async () => {
    const j = await judgeDictation("abre um pull request do branch atual", captureFetch(FIX_ROTA));
    expect(j?.rota).toBe("comando_agente");
    expect(j?.confidence).toBeCloseTo(0.98);
    expect(j?.model).toBe("jev-1.13.0");
  });
  it("response without choice → null (doesn't decide on garbage)", async () => {
    const j = await judgeDictation("x", captureFetch({ model: "m", answers: { rota: { type: "choice" } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    expect(j).toBeNull();
  });
  it("fail-soft: API error → null (F9 pastes as always)", async () => {
    const j = await judgeDictation("x", async () => jsonResponse({ detail: { message: "boom" } }, 500));
    expect(j).toBeNull();
  });
});

describe("judgeSession", () => {
  it("maps the 4 responses", async () => {
    const s = await judgeSession("quero que você olha o diff…", { mode: "tela+mic" }, captureFetch(FIX_SESSAO));
    expect(s?.rota).toBe("comando_agente");
    expect(s?.relevancia).toBeCloseTo(2.92);
    expect(s?.pedido).toBeCloseTo(0.98);
    expect(s?.risco).toBeCloseTo(0.97);
    expect(s?.confidence).toBeCloseTo(0.98);
  });
  it("unknown option in the response → route null, rest standing", async () => {
    const bad = {
      model: "jev-1.13.0",
      answers: {
        ...FIX_SESSAO.answers,
        rota: { type: "choice", choice: "isso_nao_existe", confidence: 0.9, probabilities: {} },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const s = await judgeSession("x", undefined, captureFetch(bad));
    expect(s?.rota).toBeNull();
    expect(s?.relevancia).not.toBeNull();
  });
});

describe("jevJudge (payload and kill-switch)", () => {
  it("payload follows the API contract (URL/model/questions)", async () => {
    const cap: { url?: string; body?: any } = {};
    const v = await jevJudge({
      state: { transcript: "x" },
      questions: { rota: Q_ROTA },
      origem: "ditado",
      fetch: captureFetch(FIX_ROTA, cap),
    });
    expect(cap.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(cap.body.model).toBe("jev-latest");
    expect(Object.keys(cap.body.questions)).toEqual(["rota"]);
    expect(v?.respostas.rota.choice).toBe("comando_agente");
  });
  it("VOICECAST_JEV=0 turns it off without touching the network", async () => {
    const prev = process.env.VOICECAST_JEV;
    process.env.VOICECAST_JEV = "0";
    const v = await jevJudge({
      state: "x",
      questions: { rota: Q_ROTA },
      origem: "ditado",
      fetch: async () => {
        throw new Error("active kill-switch must not hit the network");
      },
    });
    process.env.VOICECAST_JEV = prev;
    expect(v).toBeNull();
  });
});

describe("decidePaste — F9 truth table (the UX contract)", () => {
  const j = (rota: string, confidence: number): DictationJudgment =>
    ({ rota: rota as DictationJudgment["rota"], confidence, model: "test", latenciaMs: 1 }) as DictationJudgment;

  it("no judgment → paste (fail-soft preserves the old behavior)", () => {
    expect(decidePaste(null)).toEqual({ paste: true, motivo: expect.stringContaining("no judgment") });
  });
  it("pure dictation → paste", () => {
    expect(decidePaste(j("ditado_texto", 0.99)).paste).toBe(true);
  });
  it("low confidence → paste (doesn't decide on its own)", () => {
    const d = decidePaste(j("comando_agente", AUTO_CONFIDENCE - 0.01));
    expect(d.paste).toBe(true);
    expect(d.motivo).toContain("confidence");
  });
  it("command for the agent with high confidence → does NOT paste", () => {
    const d = decidePaste(j("comando_agente", 0.98));
    expect(d.paste).toBe(false);
    expect(d.motivo).toBe("comando_agente");
  });
  it("annotation and social chat with high confidence → do NOT paste", () => {
    expect(decidePaste(j("anotacao_contexto", 0.95)).paste).toBe(false);
    expect(decidePaste(j("conversa_social", 0.93)).paste).toBe(false);
  });
});
