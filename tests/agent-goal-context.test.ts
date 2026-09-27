/**
 * goalContextEnricher (C3) — enriquecedor do goal contra a biblioteca REAL
 * (electron mockado → tmpdir, fs real) e integração ponta a ponta com o
 * agente fake do runner: o bloco delimitado do contexto tem que chegar no
 * argv do agente (e o goal frio não carrega nada).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), "voicecast-goalctx-test");
  return {
    app: { getPath: () => join(root, "userData") },
    clipboard: { writeText: () => {} },
  };
});

import { goalContextEnricher } from "../src/main/agent/goal-context";
import { runGoal, type RunnerConfig } from "../src/main/agent/runner";
import {
  SESSION_CONTEXT_BEGIN,
  SESSION_CONTEXT_END,
} from "../src/shared/agent-context";

const ROOT = path.join(os.tmpdir(), "voicecast-goalctx-test");
const SESSIONS = path.join(ROOT, "voicecast", "sessions"); // appDataDir = userData/../voicecast
const DAY = "2026-09-27";

let seq = 0;

interface MakeSessionOpts {
  ageMin: number;
  relevancia?: number;
  transcriptText?: string;
  durationS?: number;
  comMidia?: boolean;
}

/** Sessão mínima na biblioteca real (meta + mp4 + transcript opcional). */
function makeSession(o: MakeSessionOpts): { dir: string; name: string } {
  seq += 1;
  const name = `${String(1000 + seq)}-c3s${seq}`;
  const root = path.join(SESSIONS, DAY, name);
  fs.mkdirSync(root, { recursive: true });
  if (o.comMidia !== false) fs.writeFileSync(path.join(root, "session.mp4"), "fake");
  const durationS = o.durationS ?? 60;
  const startedAt = new Date(Date.now() - (o.ageMin * 60 + durationS) * 1000).toISOString();
  const meta: Record<string, unknown> = {
    status: "finalizada",
    startedAt,
    durationS,
    mode: "screen",
    title: `Sessão de teste ${seq}`,
  };
  if (o.relevancia !== undefined) meta.jev = { model: "jev-test", judgedAt: startedAt, relevancia: o.relevancia };
  fs.writeFileSync(path.join(root, "meta.json"), JSON.stringify(meta));
  if (o.transcriptText !== undefined) {
    const words = o.transcriptText
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4, p: 0.9 }));
    fs.writeFileSync(
      path.join(root, "transcript.json"),
      JSON.stringify({ text: o.transcriptText, language: "pt", words, segments: [], transcribedAt: startedAt }),
    );
  }
  return { dir: DAY, name };
}

let cfg: RunnerConfig;

beforeAll(() => {
  cfg = {
    enabled: true,
    agentBin: path.join(import.meta.dirname, "fixtures", "fake-agent.sh"),
    timeoutMs: 10_000,
    direct: true,
  };
  fs.chmodSync(cfg.agentBin, 0o755);
});

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.FAKE_ECHO_ARGS;
});

describe("goalContextEnricher — política contra a biblioteca real", () => {
  it("sessão recente e relevante → bloco delimitado com título e fala no goal", async () => {
    makeSession({ ageMin: 5, relevancia: 2.7, transcriptText: "ajuda a abrir o PR do cockpit" });
    const r = await goalContextEnricher()("troca o título do PR");
    expect(r.included).toBe(true);
    expect(r.contextChars).toBeGreaterThan(0);
    expect(r.goal.startsWith("troca o título do PR")).toBe(true); // goal vem primeiro
    expect(r.goal).toContain(SESSION_CONTEXT_BEGIN);
    expect(r.goal).toContain(SESSION_CONTEXT_END);
    expect(r.goal).toContain("Sessão de teste 1");
    expect(r.goal).toContain("ajuda a abrir o PR do cockpit");
    expect(r.goal).toContain("relevância 2.7/3"); // julgamento Jev vai junto
  });

  it("sessão velha (2h), mesmo relevante → goal intacto", async () => {
    makeSession({ ageMin: 120, relevancia: 3, transcriptText: "fala antiga" });
    const r = await goalContextEnricher()("meu goal");
    expect(r).toEqual({ goal: "meu goal", included: false, contextChars: 0 });
  });

  it("relevância < 2 → goal intacto", async () => {
    makeSession({ ageMin: 5, relevancia: 1.5, transcriptText: "fala irrelevante" });
    const r = await goalContextEnricher()("meu goal");
    expect(r.included).toBe(false);
  });

  it("Jev ausente + recentíssima com transcript → inclui (política conservadora)", async () => {
    makeSession({ ageMin: 2, transcriptText: "acabei de gravar isso" });
    const r = await goalContextEnricher()("meu goal");
    expect(r.included).toBe(true);
    expect(r.goal).toContain("acabei de gravar isso");
  });

  it("Jev ausente + 10min → não inclui", async () => {
    makeSession({ ageMin: 10, transcriptText: "fala de dez minutos atrás" });
    expect((await goalContextEnricher()("g")).included).toBe(false);
  });

  it("Jev ausente + sem transcript → não inclui", async () => {
    makeSession({ ageMin: 2 });
    expect((await goalContextEnricher()("g")).included).toBe(false);
  });

  it("Jev ok + sem transcript → inclui sem quebrar (markdown sem seção de fala)", async () => {
    makeSession({ ageMin: 5, relevancia: 3 });
    const r = await goalContextEnricher()("g");
    expect(r.included).toBe(true);
    expect(r.goal).toContain("### voicecast");
    expect(r.goal).not.toContain("Fala:");
  });

  it("sem sessões → goal intacto", async () => {
    const r = await goalContextEnricher()("meu goal");
    expect(r).toEqual({ goal: "meu goal", included: false, contextChars: 0 });
  });

  it("última sessão sem mídia (getSessionDetail null) → fail-soft, goal intacto", async () => {
    makeSession({ ageMin: 5, relevancia: 3, comMidia: false });
    expect((await goalContextEnricher()("g")).included).toBe(false);
  });

  it("a ÚLTIMA sessão é a mais recente (duas sessões, a mais nova decide)", async () => {
    makeSession({ ageMin: 90, relevancia: 3, transcriptText: "sessão antiga" });
    makeSession({ ageMin: 3, relevancia: 1.2, transcriptText: "sessão nova irrelevante" });
    const r = await goalContextEnricher()("g");
    expect(r.included).toBe(false); // a mais nova manda e ela é irrelevante
  });
});

describe("goalContextEnricher — truncamento obrigatório", () => {
  it("transcript gigante → contexto truncado em ~2k tokens, nunca o transcript completo", async () => {
    makeSession({ ageMin: 5, relevancia: 3, transcriptText: "palavra ".repeat(3000) }); // ~21k chars
    const r = await goalContextEnricher()("g");
    expect(r.included).toBe(true);
    // orçamento de ~2000 tokens ≈ 8k chars (+ margem do marcador)
    expect(r.contextChars).toBeLessThanOrEqual(8100);
    expect(r.goal).toContain("… (contexto truncado)");
    expect(r.goal.length).toBeLessThan(21_000); // transcript completo NUNCA vai
  });
});

describe("integração ponta a ponta — o bloco chega no agente fake", () => {
  it("runGoal + enricher real → bloco de contexto no argv do agente", async () => {
    makeSession({ ageMin: 5, relevancia: 2.7, transcriptText: "contexto que tem que chegar no agente" });
    process.env.FAKE_ECHO_ARGS = "1";
    const r = await runGoal(
      { id: "c3-com", goal: "meu goal falado", cwd: os.tmpdir(), enrich: goalContextEnricher() },
      cfg,
    );
    expect(r.phase).toBe("completed");
    expect(r.stdout).toContain("ok do agente");
    expect(r.stdout).toContain(SESSION_CONTEXT_BEGIN);
    expect(r.stdout).toContain("contexto que tem que chegar no agente");
    expect(r.stdout).toContain(SESSION_CONTEXT_END);
  });

  it("goal frio (sessão velha) → agente recebe o goal puro, sem bloco", async () => {
    makeSession({ ageMin: 120, relevancia: 3, transcriptText: "fala antiga" });
    process.env.FAKE_ECHO_ARGS = "1";
    const r = await runGoal(
      { id: "c3-sem", goal: "meu goal falado", cwd: os.tmpdir(), enrich: goalContextEnricher() },
      cfg,
    );
    expect(r.phase).toBe("completed");
    expect(r.stdout).not.toContain("CONTEXTO DA ÚLTIMA");
    expect(r.stdout).toContain("meu goal falado");
  });
});
