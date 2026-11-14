/**
 * Voice dataset access (W2a — issue #3) against a FIXTURE in tmp —
 * NEVER points at the user's real corpus. Layout mirrors disk:
 * transcriptions/YYYY-MM-DD/<id>.json with words + validation.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    app: { getPath: () => join(tmpdir(), "voicecast-dataset-test", "userData") },
    clipboard: { writeText: () => {} },
  };
});

import { getDatasetItem, listDatasetItems, writeDatasetCorrection } from "../src/main/dataset";

const ROOT = path.join(os.tmpdir(), "voicecast-dataset-test", "dataset");

function corpusItem(id: string, day: string, text: string, validation?: unknown): string {
  const dir = path.join(ROOT, "transcriptions", day);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    ts: `${day}T01:14:52`,
    audio: `raw/${day}/${id}.wav`,
    duration_s: 2.5,
    text,
    chars: text.length,
    confidence: 0.8,
    device: "?",
    paste_mode: "clipboard",
    model: "large-v3-turbo",
    language: "pt",
    source: "dictation",
    n_words: text.split(" ").length,
    words: text.split(" ").map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4, p: 0.7 })),
    validation: validation ?? null,
    ready_for_export: false,
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
  return file;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(path.join(os.tmpdir(), "voicecast-dataset-test"), { recursive: true, force: true });
});

describe("listDatasetItems", () => {
  it("lists newest first, with preview and validated flag", () => {
    corpusItem("010000-aaaaaaaa", "2026-09-18", "primeiro ditado antigo");
    corpusItem("120000-bbbbbbbb", "2026-09-19", "segundo ditado novo", {
      corrected_text: "segundo corrigido",
      ts: "2026-09-19T12:30:00",
      n_edits: 1,
      edits: [],
      labeled_by: "panel",
    });
    const items = listDatasetItems({ root: ROOT });
    expect(items.map((i) => i.id)).toEqual(["120000-bbbbbbbb", "010000-aaaaaaaa"]);
    expect(items[0].validated).toBe(true);
    expect(items[1].validated).toBe(false);
    expect(items[1].preview).toBe("primeiro ditado antigo");
  });

  it("query filters by text substring (case-insensitive)", () => {
    corpusItem("010000-aaaaaaaa", "2026-09-18", "comprar café");
    corpusItem("010100-bbbbbbbb", "2026-09-18", "reunião às três");
    const items = listDatasetItems({ root: ROOT, query: "CAFÉ" });
    expect(items.map((i) => i.id)).toEqual(["010000-aaaaaaaa"]);
  });

  it("labeled=1 filter only labeled ones; 0 only uncorrected", () => {
    corpusItem("010000-aaaaaaaa", "2026-09-18", "sem correção");
    corpusItem("010100-bbbbbbbb", "2026-09-18", "com correção", {
      corrected_text: "x", ts: "2026-09-18T01:20:00", n_edits: 0, edits: [], labeled_by: "panel",
    });
    expect(listDatasetItems({ root: ROOT, labeled: "1" }).map((i) => i.id)).toEqual(["010100-bbbbbbbb"]);
    expect(listDatasetItems({ root: ROOT, labeled: "0" }).map((i) => i.id)).toEqual(["010000-aaaaaaaa"]);
  });

  it("no datasets dir → [] (fail-soft, never throws)", () => {
    expect(listDatasetItems({ root: path.join(ROOT, "inexistente") })).toEqual([]);
    expect(listDatasetItems({ root: null })).toEqual([]);
  });

  it("unreadable JSON is ignored (parity with the panel)", () => {
    corpusItem("010000-aaaaaaaa", "2026-09-18", "ok");
    fs.writeFileSync(path.join(ROOT, "transcriptions", "2026-09-18", "010200-cccccccc.json"), "{quebrado");
    expect(listDatasetItems({ root: ROOT })).toHaveLength(1);
  });
});

describe("getDatasetItem", () => {
  it("full detail: words, validation, audioUrl", () => {
    const id = "010000-aaaaaaaa";
    corpusItem(id, "2026-09-18", "um dois três");
    fs.mkdirSync(path.join(ROOT, "raw", "2026-09-18"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "raw", "2026-09-18", `${id}.wav`), "wav");
    const d = getDatasetItem(id, ROOT);
    expect(d?.id).toBe(id);
    expect(d?.words).toHaveLength(3);
    expect(d?.words[1]).toEqual({ w: "dois", start: 0.5, end: 0.9, p: 0.7 });
    expect(d?.validation).toBeNull();
    expect(d?.audioUrl).toContain("/raw/2026-09-18/");
    expect(d?.audioUrl?.startsWith("file:///")).toBe(true);
  });

  it("id with traversal → null; nonexistent id → null", () => {
    expect(getDatasetItem("../../etc", ROOT)).toBeNull();
    expect(getDatasetItem("999999-zzzzzzzz", ROOT)).toBeNull();
  });
});

describe("writeDatasetCorrection — corpus write (real data: atomic and conservative)", () => {
  it("writes the validation block into the SAME JSON; original text/words untouched", () => {
    const id = "010000-aaaaaaaa";
    const file = corpusItem(id, "2026-09-18", "vamos favar isso");
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    const st = writeDatasetCorrection(id, "vamos fechar isso", [{ index: 1, originalW: "favar", correctedW: "fechar" }], {
      root: ROOT,
      now: new Date(2026, 8, 29, 10, 0, 0),
    });
    expect(st).toBe("ok");
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    // original fields preserved (never truncate/rewrite the raw data)
    expect(after.text).toBe(before.text);
    expect(after.words).toEqual(before.words);
    expect(after.id).toBe(id);
    // validation in the corpus schema
    expect(after.validation).toEqual({
      corrected_text: "vamos fechar isso",
      ts: "2026-09-29T10:00:00",
      n_edits: 1,
      edits: [{ index: 1, originalW: "favar", correctedW: "fechar" }],
      labeled_by: "voicecast",
    });
    // atomic write: no .tmp left behind
    expect(fs.readdirSync(path.join(ROOT, "transcriptions", "2026-09-18")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("idempotent: reapplying overwrites the previous validation (corrections.py parity)", () => {
    const id = "010000-aaaaaaaa";
    corpusItem(id, "2026-09-18", "texto", {
      corrected_text: "antiga", ts: "2026-09-18T01:00:00", n_edits: 0, edits: [], labeled_by: "panel",
    });
    const st = writeDatasetCorrection(id, "nova", [], { root: ROOT, now: new Date() });
    expect(st).toBe("ok");
    const after = JSON.parse(
      fs.readFileSync(path.join(ROOT, "transcriptions", "2026-09-18", `${id}.json`), "utf8"),
    );
    expect(after.validation.corrected_text).toBe("nova");
    expect(after.validation.labeled_by).toBe("voicecast");
  });

  it("nonexistent item → 'ausente' (fail-soft)", () => {
    expect(writeDatasetCorrection("999999-zzzzzzzz", "x", [], { root: ROOT })).toBe("ausente");
  });

  it("no datasets dir → 'ausente', nothing is written", () => {
    expect(writeDatasetCorrection("010000-aaaaaaaa", "x", [], { root: null })).toBe("ausente");
  });

  it("id with traversal → 'ausente'", () => {
    expect(writeDatasetCorrection("../fuga", "x", [], { root: ROOT })).toBe("ausente");
  });

  it("unreadable JSON → 'erro' (never overwrites data it failed to read)", () => {
    const dir = path.join(ROOT, "transcriptions", "2026-09-18");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "010000-aaaaaaaa.json"), "{quebrado");
    expect(writeDatasetCorrection("010000-aaaaaaaa", "x", [], { root: ROOT })).toBe("erro");
  });
});
