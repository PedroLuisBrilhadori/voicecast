/**
 * Ditado salvo SEM transcrição (ASR off/fora do ar) — o áudio nunca é
 * descartado: vira sessão "pending" e o transcribeAndStore recupera depois
 * pelo áudio (audio.webm), sem depender de mp4. Electron mockado
 * (`app.getPath` → tmpdir) e módulo asr mockado; o resto é fs real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), "voicecast-ditado-save-test");
  return {
    app: { getPath: () => join(root, "userData") },
    clipboard: { writeText: () => {} },
  };
});

// asr mockado: health ok e transcrição que devolve texto fixo (o fallback de
// áudio do transcribeAndStore é o que está em teste, não o cliente HTTP)
vi.mock("../src/main/asr", async () => {
  let healthOk = true;
  return {
    asrHealth: async () => (healthOk ? { ok: true, source: "fake" } : { ok: false }),
    transcribeSession: async (file: string) => ({
      text: `fake de ${path.basename(file)}`,
      language: "pt",
      words: [],
      segments: [],
      transcribedAt: new Date().toISOString(),
    }),
    asrModelStatus: async () => null,
    __setHealthOk: (v: boolean) => {
      healthOk = v;
    },
  };
});

// jev mockado: o julgamento é fail-soft e alheio ao que se testa aqui (com
// TYPESAFE_API_KEY no ambiente ele faria chamada real)
vi.mock("../src/main/jev", () => ({ judgeSession: async () => null }));

const { saveDictationSession, transcribeAndStore } = await import("../src/main/library");
const { sessionDirs } = await import("../src/main/storage");

const ROOT = path.join(os.tmpdir(), "voicecast-ditado-save-test");
const SESSIONS = path.join(ROOT, "voicecast", "sessions");
const STARTED_AT = new Date("2026-10-23T12:00:00").getTime();

function fakeTranscript() {
  return {
    text: "olá mundo",
    language: "pt",
    words: [{ w: "olá", start: 0, end: 0.4, p: 0.9 }],
    segments: [],
    transcribedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  fs.rmSync(SESSIONS, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("saveDictationSession", () => {
  it("com transcript: salva tudo e marca done (caminho de sempre)", () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", fakeTranscript());
    const d = sessionDirs(dir, name);
    expect(fs.existsSync(d.audio)).toBe(true);
    expect(fs.existsSync(d.transcript)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("done");
    expect(meta.mode).toBe("ditado");
  });

  it("sem transcript (ASR off): áudio SALVO, sem arquivo de transcrição, pending", () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", null);
    const d = sessionDirs(dir, name);
    expect(fs.existsSync(d.audio)).toBe(true); // a fala não pode sumir
    expect(fs.existsSync(d.transcript)).toBe(false);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("pending");
    expect(meta.status).toBe("finalizada");
    expect(meta.title).toBe("Ditado (sem transcrição)");
  });
});

describe("transcribeAndStore em sessão de ditado (áudio, sem mp4)", () => {
  it("retranscreve pelo audio.webm e marca done", async () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", null);
    const ok = await transcribeAndStore(dir, name);
    expect(ok).toBe(true);
    const d = sessionDirs(dir, name);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("done");
    const t = JSON.parse(fs.readFileSync(d.transcript, "utf8"));
    expect(t.text).toContain("fake de audio.webm");
  });

  it("ASR fora do ar: marca sem-asr, sessão e áudio intactos", async () => {
    const asr = (await import("../src/main/asr")) as unknown as {
      __setHealthOk: (v: boolean) => void;
    };
    asr.__setHealthOk(false);
    try {
      const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", null);
      const ok = await transcribeAndStore(dir, name);
      expect(ok).toBe(false);
      const d = sessionDirs(dir, name);
      const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
      expect(meta.transcriptStatus).toBe("sem-asr");
      expect(fs.existsSync(d.audio)).toBe(true);
    } finally {
      asr.__setHealthOk(true);
    }
  });
});
