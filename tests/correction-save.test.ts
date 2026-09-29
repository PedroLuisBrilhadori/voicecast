/**
 * saveCorrection (W2a) — correção de ditado na sessão: transcript.json com
 * words editadas NO LUGAR (timings preservados), meta.correction, e escrita no
 * dataset do voice quando a sessão tem datasetId (fail-soft sem dataset).
 * Electron mockado; fixture em tmp — NUNCA o corpus real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), "voicecast-correction-test");
  return {
    app: { getPath: () => join(root, "userData") },
    clipboard: { writeText: () => {} },
  };
});

import { saveCorrection } from "../src/main/library";

const ROOT = path.join(os.tmpdir(), "voicecast-correction-test");
const SESSIONS = path.join(ROOT, "voicecast", "sessions");
const DAY = "2026-09-29";
const DATASET = path.join(ROOT, "voice-dictation", "datasets");

/** Sessão ditado com transcript de 3 palavras (opcional: sem words). */
function makeDictation(name: string, opts: { words?: boolean; datasetId?: string } = {}): string {
  const root = path.join(SESSIONS, DAY, name);
  fs.mkdirSync(root, { recursive: true });
  const words = [
    { w: "vamos", start: 0.0, end: 0.42, p: 0.71 },
    { w: "favar", start: 0.5, end: 0.9, p: 0.44 },
    { w: "isso", start: 1.0, end: 1.3, p: 0.95 },
  ];
  fs.writeFileSync(
    path.join(root, "transcript.json"),
    JSON.stringify({
      text: "vamos favar isso",
      language: "pt",
      words: opts.words === false ? [] : words,
      segments: [],
      transcribedAt: "2026-09-29T10:00:00.000Z",
      model: "large-v3-turbo",
    }),
  );
  fs.writeFileSync(
    path.join(root, "meta.json"),
    JSON.stringify({
      status: "finalizada",
      startedAt: `${DAY}T10:00:00.000Z`,
      durationS: 1.3,
      mode: "ditado",
      sourceLabel: "mic",
      title: "vamos favar isso",
      transcriptStatus: "done",
      ...(opts.datasetId ? { datasetId: opts.datasetId } : {}),
    }),
  );
  return root;
}

function corpusItem(id: string, text: string): string {
  const dir = path.join(DATASET, "transcriptions", DAY);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      ts: `${DAY}T10:00:00`,
      text,
      words: text.split(" ").map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4, p: 0.7 })),
      validation: null,
    }),
  );
  return file;
}

const DS_ID = "100000-deadbeef";

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.VOICECAST_DATASET_DIR;
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.VOICECAST_DATASET_DIR;
});

describe("saveCorrection — sessão ditado (voicecast)", () => {
  it("edita palavras preservando timings e recompõe o texto", () => {
    makeDictation("1000-hash1");
    const r = saveCorrection(`${DAY}`, "1000-hash1", {
      correctedText: "",
      edits: [{ index: 1, originalW: "favar", correctedW: "fechar" }],
    });
    expect(r).toEqual({ ok: true, alvo: "voicecast", dataset: "ausente" });
    const t = JSON.parse(fs.readFileSync(path.join(SESSIONS, DAY, "1000-hash1", "transcript.json"), "utf8"));
    expect(t.words[1]).toEqual({ w: "fechar", start: 0.5, end: 0.9, p: 0.44 }); // timing/conf preservados
    expect(t.words[0].w).toBe("vamos");
    expect(t.text).toBe("vamos fechar isso");
    const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS, DAY, "1000-hash1", "meta.json"), "utf8"));
    expect(meta.correction.nEdits).toBe(1);
    expect(meta.correction.dataset).toBe("ausente");
    expect(typeof meta.correction.correctedAt).toBe("string");
    // escrita atômica: sem .tmp sobrando
    expect(fs.readdirSync(path.join(SESSIONS, DAY, "1000-hash1")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("grava nos DOIS alvos quando a sessão tem datasetId e o dataset existe (alvo=ambos)", () => {
    makeDictation("1001-hash2", { datasetId: DS_ID });
    corpusItem(DS_ID, "vamos favar isso");
    process.env.VOICECAST_DATASET_DIR = DATASET;
    const r = saveCorrection(DAY, "1001-hash2", {
      correctedText: "vamos fechar isso",
      edits: [{ index: 1, originalW: "favar", correctedW: "fechar" }],
    });
    expect(r).toEqual({ ok: true, alvo: "ambos", dataset: "ok" });
    const corpus = JSON.parse(fs.readFileSync(path.join(DATASET, "transcriptions", DAY, `${DS_ID}.json`), "utf8"));
    expect(corpus.text).toBe("vamos favar isso"); // cru do corpus NUNCA muda
    expect(corpus.validation.corrected_text).toBe("vamos fechar isso");
    expect(corpus.validation.labeled_by).toBe("voicecast");
  });

  it("fail-soft: datasetId apontando pra corpus ausente → alvo=voicecast, dataset=ausente", () => {
    makeDictation("1002-hash3", { datasetId: DS_ID });
    const r = saveCorrection(DAY, "1002-hash3", {
      correctedText: "vamos fechar isso",
      edits: [{ index: 1, originalW: "favar", correctedW: "fechar" }],
    });
    expect(r).toEqual({ ok: true, alvo: "voicecast", dataset: "ausente" });
    // correção local intacta mesmo assim
    const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS, DAY, "1002-hash3", "meta.json"), "utf8"));
    expect(meta.correction.nEdits).toBe(1);
  });

  it("words vazio (gancho fake/ditado antigo): correção é do texto inteiro", () => {
    makeDictation("1003-hash4", { words: false });
    const r = saveCorrection(DAY, "1003-hash4", {
      correctedText: "outro texto corrigido",
      edits: [],
    });
    expect(r).toEqual({ ok: true, alvo: "voicecast", dataset: "ausente" });
    const t = JSON.parse(fs.readFileSync(path.join(SESSIONS, DAY, "1003-hash4", "transcript.json"), "utf8"));
    expect(t.text).toBe("outro texto corrigido");
    // pós-rewrite (2026-09-29): texto corrigido gera words redistribuídas em
    // t=0 (não há referência temporal) — transcript não fica mais sem words
    expect(t.words.map((w: { w: string }) => w.w)).toEqual(["outro", "texto", "corrigido"]);
    const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS, DAY, "1003-hash4", "meta.json"), "utf8"));
    expect(meta.correction.nEdits).toBe(3); // diff do ASR p/ o corrigido
  });

  it("sessão sem transcript → erro honesto, nada é escrito", () => {
    const root = path.join(SESSIONS, DAY, "1004-hash5");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "meta.json"), JSON.stringify({ mode: "ditado" }));
    const r = saveCorrection(DAY, "1004-hash5", { correctedText: "x", edits: [] });
    expect(r.ok).toBe(false);
  });

  it("sessão inexistente → erro", () => {
    expect(saveCorrection(DAY, "9999-nope", { correctedText: "x", edits: [] }).ok).toBe(false);
  });
});
