/**
 * Local ASR client (voice-dictation :8701) — the shared v2 service.
 * URL failover (voice asr_router pattern), health, and file transcription.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFfmpeg, runFfmpeg } from "./ffmpeg";
import { logError, logInfo } from "./logging";

export interface AsrWord {
  w: string;
  start: number;
  end: number;
  p: number;
}
export interface AsrSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
}
export interface Transcript {
  text: string;
  language: string | null;
  words: AsrWord[];
  segments: AsrSegment[];
  model?: string;
  transcribedAt: string;
}

function asrUrls(): { name: string; url: string }[] {
  const raw =
    process.env.VOICECAST_ASR_URLS ||
    process.env.VOICE_ASR_URLS ||
    "http://127.0.0.1:8701";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, url] = item.includes("|") ? item.split("|") : [item, item];
      return { name: name || url, url: (url ?? item).replace(/\/$/, "") };
    });
}

/** Waits for the host to come up before giving up (spawn warmup: the port opens
 *  within seconds; model loading continues in the background on the service). */
export async function asrHealth(opts?: {
  waitMs?: number;
}): Promise<{ ok: boolean; source?: string }> {
  const deadline = Date.now() + (opts?.waitMs ?? 0);
  for (;;) {
    for (const ep of asrUrls()) {
      try {
        const r = await fetch(`${ep.url}/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return { ok: true, source: ep.name };
      } catch {}
    }
    if (Date.now() >= deadline) return { ok: false };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** Model status on the ASR (/v1/model-status) — used to show in the bar
 *  WHY the first transcription after boot is slow (model load on the
 *  GPU). Fail-soft: null when the service doesn't respond. */
export async function asrModelStatus(): Promise<{
  loaded: boolean;
  expectedLoadS: number;
} | null> {
  for (const ep of asrUrls()) {
    try {
      const r = await fetch(`${ep.url}/v1/model-status`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) continue;
      const j = (await r.json()) as { loaded?: boolean; expected_load_s?: number };
      return { loaded: Boolean(j.loaded), expectedLoadS: Number(j.expected_load_s) || 0 };
    } catch {}
  }
  return null;
}

/** Extracts session mp4 audio to 16k mono wav (uniscraper/asr.ts pattern). */
async function extractWav(mp4: string): Promise<string> {
  const wav = path.join(tmpdir(), `voicecast-${path.basename(mp4, ".mp4")}.wav`);
  const ff = await resolveFfmpeg();
  await runFfmpeg(ff, ["-y", "-i", mp4, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  return wav;
}

/** Transcribes audio bytes (webm/opus, wav…) directly via /v1/transcribe. */
export async function transcribeBuffer(
  buf: Buffer,
  filename: string,
): Promise<Transcript> {
  let lastErr = "no endpoint";
  for (const ep of asrUrls()) {
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/webm" }), filename);
      logInfo(`ASR: transcribing via ${ep.name} (${(buf.length / 1_048_576).toFixed(2)}MB)`);
      const r = await fetch(`${ep.url}/v1/transcribe`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(600_000),
      });
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const j = (await r.json()) as {
        text: string;
        language?: string | null;
        words?: AsrWord[];
        segments?: AsrSegment[];
        model?: string;
      };
      return {
        text: j.text ?? "",
        language: j.language ?? null,
        words: j.words ?? [],
        segments: j.segments ?? [],
        model: j.model,
        transcribedAt: new Date().toISOString(),
      };
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`ASR unavailable (${lastErr})`);
}

/** Transcribes any audio/video file: extracts 16k wav via ffmpeg and sends it. */
export async function transcribeAudioFile(file: string): Promise<Transcript> {
  const wav = await extractWav(file);
  try {
    return await transcribeBuffer(fs.readFileSync(wav), path.basename(wav));
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/** Transcribes the session mp4 via /v1/transcribe (endpoint failover). */
export async function transcribeSession(mp4: string): Promise<Transcript> {
  return transcribeAudioFile(mp4);
}

export function logAsrError(e: unknown): void {
  logError("ASR:", e);
}
