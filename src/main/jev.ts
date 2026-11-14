/**
 * Jev (TypeSafe/systemone) in voicecast — local decisions, no LLM in the loop.
 * Step 2 of PLANO-JEV-CU: F9 routing + post-session judgment.
 *
 * Fail-SOFT: judgment is an improvement, not a dependency — without a key, on a
 * network error, or disabled (VOICECAST_JEV=0), everything returns null and the app behaves
 * exactly as before (F9 pastes, session saved without a jev field).
 * Key: env TYPESAFE_API_KEY → %APPDATA%/voicecast/jev-key.txt (1 line).
 * OTel metrics: voicecast_jev_decisions_total{origem,status} and
 * voicecast_jev_seconds{origem}.
 */
import path from "node:path";
import fs from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { counter, histogram } from "./telemetry";
import {
  AUTO_CONFIDENCE,
  JEV_TIMEOUT_DITADO_MS,
  JEV_TIMEOUT_SESSAO_MS,
  Q_PEDIDO,
  Q_RELEVANCIA,
  Q_RISCO,
  Q_ROTA,
  ROTAS,
  type Rota,
} from "./jev-questions";

const M_DECISIONS = counter("voicecast_jev_decisions_total", "Jev decisions by origin/status");
const H_JEV = histogram("voicecast_jev_seconds", "Jev judgment latency");

export function jevEnabled(): boolean {
  return process.env.VOICECAST_JEV !== "0";
}

// logging/storage import electron at the top — the dynamic import keeps this
// module importable by tests (vitest runs without Electron).
async function log(method: "info" | "error", msg: string, ...args: unknown[]): Promise<void> {
  try {
    const l = await import("./logging.js");
    (method === "info" ? l.logInfo : l.logError)(msg, ...args);
  } catch {
    console[method === "info" ? "log" : "error"](`[jev] ${msg}`, ...args);
  }
}

let cachedKey: string | null | undefined;

async function jevKeyFile(): Promise<string> {
  try {
    const { appDataDir } = await import("./storage.js");
    return path.join(appDataDir(), "jev-key.txt");
  } catch {
    return path.join(process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd(), "voicecast", "jev-key.txt");
  }
}

export async function jevApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.TYPESAFE_API_KEY) {
    cachedKey = process.env.TYPESAFE_API_KEY;
    return cachedKey;
  }
  try {
    const file = await jevKeyFile();
    const key = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "";
    cachedKey = key || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

// ── client (injectable fetch for tests — same workspace pattern) ──────

export interface JevAnswer {
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevVerdict {
  respostas: Record<string, JevAnswer>;
  model: string;
  latenciaMs: number;
  usage: { input_tokens: number; output_tokens: number };
}

let cachedClient: { key: string; fetch?: unknown; client: TypeSafeClient } | null = null;

async function getClient(key: string, fetchImpl?: unknown): Promise<TypeSafeClient> {
  if (!cachedClient || cachedClient.key !== key || cachedClient.fetch !== fetchImpl) {
    cachedClient = {
      key,
      fetch: fetchImpl,
      client: new TypeSafeClient({
        apiKey: key,
        logLevel: "off",
        ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
      }),
    };
  }
  return cachedClient.client;
}

/** One systemone call. Fail-soft: null on off/no-key/error (logged + metric). */
export async function jevJudge(opts: {
  state: unknown;
  questions: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  /** telemetry/latency label (ditado | sessao) */
  origem: "ditado" | "sessao";
  fetch?: unknown;
}): Promise<JevVerdict | null> {
  if (!jevEnabled()) {
    M_DECISIONS?.add(1, { origem: opts.origem, status: "off" });
    return null;
  }
  const key = await jevApiKey();
  if (!key) {
    M_DECISIONS?.add(1, { origem: opts.origem, status: "sem-key" });
    return null;
  }
  const t0 = performance.now();
  try {
    const result = await (
      await getClient(key, opts.fetch)
    ).systemOne(
      { state: opts.state as never, questions: opts.questions as never, model: "jev-latest" },
      { timeout: opts.timeoutMs ?? JEV_TIMEOUT_SESSAO_MS, retry: { maxRetries: opts.maxRetries ?? 0 } },
    );
    const ms = performance.now() - t0;
    H_JEV?.record(ms / 1000, { origem: opts.origem });
    M_DECISIONS?.add(1, { origem: opts.origem, status: "ok" });
    const respostas: Record<string, JevAnswer> = {};
    for (const [nome, a] of Object.entries(result?.answers ?? {})) respostas[nome] = a as JevAnswer;
    return {
      respostas,
      model: result?.model ?? "jev-latest",
      latenciaMs: ms,
      usage: result?.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  } catch (e) {
    M_DECISIONS?.add(1, { origem: opts.origem, status: "erro" });
    await log("error", `jev: failed (${opts.origem}):`, String(e).slice(0, 160));
    return null;
  }
}

// ── app judgments ───────────────────────────────────────────────────

export interface DictationJudgment {
  rota: Rota;
  confidence: number;
  model: string;
  latenciaMs: number;
}

/** F9: routes the dictation intent (1 choice — hot path, ~600ms). */
export async function judgeDictation(text: string, fetchImpl?: unknown): Promise<DictationJudgment | null> {
  const v = await jevJudge({
    state: { origem: "voicecast F9 dictation", transcript: text },
    questions: { rota: Q_ROTA },
    timeoutMs: JEV_TIMEOUT_DITADO_MS,
    maxRetries: 0,
    origem: "ditado",
    fetch: fetchImpl,
  });
  const a = v?.respostas.rota;
  if (!v || !a?.choice || !ROTAS.includes(a.choice as Rota)) return null;
  return { rota: a.choice as Rota, confidence: a.confidence ?? 0, model: v.model, latenciaMs: v.latenciaMs };
}

export interface SessionJudgment {
  rota: Rota | null;
  relevancia: number | null;
  pedido: number | null;
  risco: number | null;
  confidence: number;
  model: string;
  latenciaMs: number;
}

/** Session (voice+screen or library dictation): 4 questions in one call. */
export async function judgeSession(
  transcript: string,
  ctx?: { mode?: string; title?: string },
  fetchImpl?: unknown,
): Promise<SessionJudgment | null> {
  const v = await jevJudge({
    state: { origem: "voicecast session", mode: ctx?.mode, title: ctx?.title, transcript },
    questions: { rota: Q_ROTA, relevancia: Q_RELEVANCIA, pedido: Q_PEDIDO, risco: Q_RISCO },
    timeoutMs: JEV_TIMEOUT_SESSAO_MS,
    maxRetries: 1,
    origem: "sessao",
    fetch: fetchImpl,
  });
  if (!v) return null;
  const r = v.respostas.rota;
  const rel = v.respostas.relevancia;
  const ped = v.respostas.pedido;
  const ris = v.respostas.risco;
  return {
    rota: r?.choice && ROTAS.includes(r.choice as Rota) ? (r.choice as Rota) : null,
    relevancia: typeof rel?.score === "number" ? rel.score : null,
    pedido: typeof ped?.noul === "number" ? ped.noul : null,
    risco: typeof ris?.noul === "number" ? ris.noul : null,
    confidence: r?.confidence ?? 0,
    model: v.model,
    latenciaMs: v.latenciaMs,
  };
}

// ── paste decision (pure — testable) ────────────────────────────────

export interface PasteDecision {
  paste: boolean;
  motivo: string;
}

/**
 * No judgment → paste (fail-soft preserves the old F9 behavior).
 * Route ditado_texto → paste. Low confidence → paste (doesn't decide on its own).
 * Only skips pasting when the route is NOT dictation with high confidence: an agent
 * command, an annotation, and conversation don't belong in the focused window.
 */
export function decidePaste(j: DictationJudgment | null): PasteDecision {
  if (!j) return { paste: true, motivo: "no judgment (Jev off/no key/error)" };
  if (j.rota === "ditado_texto") return { paste: true, motivo: "pure dictation" };
  if (j.confidence < AUTO_CONFIDENCE)
    return { paste: true, motivo: `confidence ${j.confidence.toFixed(2)} < ${AUTO_CONFIDENCE}` };
  return { paste: false, motivo: j.rota };
}
