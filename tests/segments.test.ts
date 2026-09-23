import { describe, expect, it } from "vitest";
import {
  clipFileBase,
  cutFileBase,
  sanitizeSegments,
  wordsInRange,
  type SessionSegment,
} from "../src/shared/segments";

/** Motor puro dos segmentos do editor (fase B) — mesmas garantias que o main
 *  aplica antes de persistir no meta.json. */
describe("sanitizeSegments", () => {
  it("mantém segmentos válidos, arredonda e ordena por inS", () => {
    const out = sanitizeSegments([
      { id: "b", label: "segundo", inS: 30.004, outS: 45 },
      { id: "a", label: "primeiro", inS: 5, outS: 12.5 },
    ]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0].inS).toBe(5);
    expect(out[1].inS).toBe(30);
  });

  it("descarta lixo: não-array, entradas não-objeto, NaN e duração < 0.2s", () => {
    expect(sanitizeSegments(undefined)).toEqual([]);
    expect(sanitizeSegments("x")).toEqual([]);
    expect(
      sanitizeSegments([
        null,
        42,
        "a",
        { id: "1", label: "nan", inS: Number.NaN, outS: 5 },
        { id: "2", label: "curto", inS: 10, outS: 10.1 },
      ]),
    ).toEqual([]);
  });

  it("clampa inS negativo e mantém o trecho quando ainda tem duração", () => {
    const out = sanitizeSegments([{ id: "n", label: "neg", inS: -3, outS: 4 }]);
    expect(out).toEqual([{ id: "n", label: "neg", inS: 0, outS: 4 }]);
  });

  it("deduplica ids duplicados (segundo ganha id novo, ambos persistem)", () => {
    const out = sanitizeSegments([
      { id: "dup", label: "a", inS: 1, outS: 2 },
      { id: "dup", label: "b", inS: 5, outS: 6 },
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });

  it("label vazio ganha default numerado e é aparado em 80 chars", () => {
    const out = sanitizeSegments([
      { id: "1", label: "   ", inS: 1, outS: 2 },
      { id: "2", label: "x".repeat(120), inS: 3, outS: 4 },
    ]);
    expect(out[0].label).toBe("Segmento 1");
    expect(out[1].label).toHaveLength(80);
  });
});

describe("nomes de arquivo derivados", () => {
  it("clipFileBase sanitiza label e embute os tempos arredondados", () => {
    // semântica idêntica ao safeNamePart histórico: cada run de não-word vira
    // um hífen (espaço e "!" são runs separados) — nomes casam com clipes antigos
    expect(clipFileBase("Meu Trecho!", 12.4, 30.9)).toBe("Meu-Trecho--12s-31s");
    expect(clipFileBase("", 0, 5)).toBe("trecho-0s-5s");
  });

  it("cutFileBase é determinístico p/ re-export sobrescrever", () => {
    expect(cutFileBase("corte", 3)).toBe("corte-3seg");
    expect(cutFileBase("", 1)).toBe("corte-1seg");
  });
});

describe("wordsInRange", () => {
  const words = [
    { w: "a", start: 0, end: 1 },
    { w: "b", start: 1, end: 2 },
    { w: "c", start: 2, end: 3 },
    { w: "d", start: 3, end: 4 },
  ];

  it("pega palavras que TOCAM o intervalo (borda: end == inS fica fora)", () => {
    expect(wordsInRange(words, 1, 3).map((w) => w.w)).toEqual(["b", "c"]);
    expect(wordsInRange(words, 0, 1).map((w) => w.w)).toEqual(["a"]);
  });

  it("intervalo no meio de uma palavra a inclui (sobreposição, não contenção)", () => {
    expect(wordsInRange(words, 1.5, 1.6).map((w) => w.w)).toEqual(["b"]);
  });
});

describe("contrato do renderer (tipos serializáveis)", () => {
  it("SessionSegment atravessa JSON sem perda", () => {
    const seg: SessionSegment = { id: "seg-1", label: "demo", inS: 1.5, outS: 9.25 };
    expect(JSON.parse(JSON.stringify(seg))).toEqual(seg);
  });
});
