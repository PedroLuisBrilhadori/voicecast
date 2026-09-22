/**
 * Testes do módulo Jev (src/main/jev.ts) — sem rede: o SDK aceita fetch
 * injetável (judgeDictation/judgeSession expõem o parâmetro), e as fixtures
 * espelham respostas reais da API (probe 2026-09-21, docs/RELATORIO-E1.md).
 * decidePaste é o coração do F9: a tabela-verdade abaixo é o contrato de UX.
 */
import { describe, expect, it } from "vitest";
import { decidePaste, jevJudge, judgeDictation, judgeSession, type DictationJudgment } from "../src/main/jev";
import { AUTO_CONFIDENCE, Q_PEDIDO, Q_RELEVANCIA, Q_RISCO, Q_ROTA, ROTAS } from "../src/main/jev-questions";

process.env.TYPESAFE_API_KEY = "test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resposta real (probe): choice 4 opções. */
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

/** Resposta real (probe): as 4 perguntas da sessão. */
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

describe("perguntas (jev-questions)", () => {
  it("opções do choice ROTA são exatamente as ROTAS — decidePaste depende delas", () => {
    expect(Q_ROTA.type).toBe("choice");
    expect(Object.keys(Q_ROTA.criteria)).toEqual([...ROTAS]);
  });
  it("primitivas corretas na sessão", () => {
    expect(Q_RELEVANCIA.type).toBe("score");
    expect(Q_PEDIDO.type).toBe("noul");
    expect(Q_RISCO.type).toBe("noul");
  });
});

describe("judgeDictation (F9)", () => {
  it("mapeia a resposta para rota+confiança", async () => {
    const j = await judgeDictation("abre um pull request do branch atual", captureFetch(FIX_ROTA));
    expect(j?.rota).toBe("comando_agente");
    expect(j?.confidence).toBeCloseTo(0.98);
    expect(j?.model).toBe("jev-1.13.0");
  });
  it("resposta sem choice → null (não decide com lixo)", async () => {
    const j = await judgeDictation("x", captureFetch({ model: "m", answers: { rota: { type: "choice" } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    expect(j).toBeNull();
  });
  it("fail-soft: erro de API → null (F9 cola como sempre)", async () => {
    const j = await judgeDictation("x", async () => jsonResponse({ detail: { message: "boom" } }, 500));
    expect(j).toBeNull();
  });
});

describe("judgeSession", () => {
  it("mapeia as 4 respostas", async () => {
    const s = await judgeSession("quero que você olha o diff…", { mode: "tela+mic" }, captureFetch(FIX_SESSAO));
    expect(s?.rota).toBe("comando_agente");
    expect(s?.relevancia).toBeCloseTo(2.92);
    expect(s?.pedido).toBeCloseTo(0.98);
    expect(s?.risco).toBeCloseTo(0.97);
    expect(s?.confidence).toBeCloseTo(0.98);
  });
  it("opção desconhecida na resposta → rota null, resto de pé", async () => {
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

describe("jevJudge (payload e kill-switch)", () => {
  it("payload no contrato da API (URL/model/questions)", async () => {
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
  it("VOICECAST_JEV=0 desliga sem tocar na rede", async () => {
    const prev = process.env.VOICECAST_JEV;
    process.env.VOICECAST_JEV = "0";
    const v = await jevJudge({
      state: "x",
      questions: { rota: Q_ROTA },
      origem: "ditado",
      fetch: async () => {
        throw new Error("kill-switch ativo não deve chamar a rede");
      },
    });
    process.env.VOICECAST_JEV = prev;
    expect(v).toBeNull();
  });
});

describe("decidePaste — tabela-verdade do F9 (o contrato de UX)", () => {
  const j = (rota: string, confidence: number): DictationJudgment =>
    ({ rota: rota as DictationJudgment["rota"], confidence, model: "test", latenciaMs: 1 }) as DictationJudgment;

  it("sem julgamento → cola (fail-soft preserva o comportamento antigo)", () => {
    expect(decidePaste(null)).toEqual({ paste: true, motivo: expect.stringContaining("sem julgamento") });
  });
  it("ditado puro → cola", () => {
    expect(decidePaste(j("ditado_texto", 0.99)).paste).toBe(true);
  });
  it("confiança baixa → cola (não decide sozinho)", () => {
    const d = decidePaste(j("comando_agente", AUTO_CONFIDENCE - 0.01));
    expect(d.paste).toBe(true);
    expect(d.motivo).toContain("confiança");
  });
  it("comando pro agente com confiança alta → NÃO cola", () => {
    const d = decidePaste(j("comando_agente", 0.98));
    expect(d.paste).toBe(false);
    expect(d.motivo).toBe("comando_agente");
  });
  it("anotação e conversa com confiança alta → NÃO colam", () => {
    expect(decidePaste(j("anotacao_contexto", 0.95)).paste).toBe(false);
    expect(decidePaste(j("conversa_social", 0.93)).paste).toBe(false);
  });
});
