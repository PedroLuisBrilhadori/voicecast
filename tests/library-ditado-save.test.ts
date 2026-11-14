/**
 * Dictation saved WITHOUT transcription (ASR off/down) — the audio is never
 * discarded: it becomes a "pending" session and transcribeAndStore recovers it
 * later from the audio (audio.webm), without depending on the mp4. Electron
 * mocked (`app.getPath` → tmpdir) and asr module mocked; the rest is real fs.
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

// asr mocked: health ok and a transcription that returns fixed text (the
// audio fallback of transcribeAndStore is what's under test, not the HTTP client)
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

// jev mocked: the judgment is fail-soft and unrelated to what's tested here (with
// TYPESAFE_API_KEY in the environment it would make a real call)
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
  it("with transcript: saves everything and marks done (the usual path)", () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", fakeTranscript());
    const d = sessionDirs(dir, name);
    expect(fs.existsSync(d.audio)).toBe(true);
    expect(fs.existsSync(d.transcript)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("done");
    expect(meta.mode).toBe("ditado");
  });

  it("no transcript (ASR off): audio SAVED, no transcript file, pending", () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", null);
    const d = sessionDirs(dir, name);
    expect(fs.existsSync(d.audio)).toBe(true); // the speech must not vanish
    expect(fs.existsSync(d.transcript)).toBe(false);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("pending");
    expect(meta.status).toBe("finalizada");
    expect(meta.title).toBe("Dictation (no transcript)");
  });
});

describe("transcribeAndStore on a dictation session (audio, no mp4)", () => {
  it("retranscribes from audio.webm and marks done", async () => {
    const { dir, name } = saveDictationSession(STARTED_AT, "webm", "YXVkaW8=", null);
    const ok = await transcribeAndStore(dir, name);
    expect(ok).toBe(true);
    const d = sessionDirs(dir, name);
    const meta = JSON.parse(fs.readFileSync(d.meta, "utf8"));
    expect(meta.transcriptStatus).toBe("done");
    const t = JSON.parse(fs.readFileSync(d.transcript, "utf8"));
    expect(t.text).toContain("fake de audio.webm");
  });

  it("ASR down: marks sem-asr, session and audio intact", async () => {
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
