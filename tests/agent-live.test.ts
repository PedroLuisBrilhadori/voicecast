import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRunnerConfig, runGoal } from "../src/main/agent/runner";

/**
 * Teste LIVE do C2b — prova contínua do desbloqueio U2: um goal REAL rodando
 * ponta a ponta via runGoal no CLI buildado do runtime (U1) com o data-dir
 * próprio auto-curado (identity keys).
 *
 * SÓ roda com VOICECAST_AGENT_LIVE=1 (default CI/dev = skip — sem rede, sem
 * custo, sem tocar ~/.zcode além do que o CLI grava em ~/.zcode/cli/).
 *
 * Requisitos: /tmp/zcode-cli-build (U1) + ~/.zcode/v2/credentials.json
 * (login do desktop). Evidência esperada: stdout "ok", phase=completed.
 */
const LIVE = process.env.VOICECAST_AGENT_LIVE === "1";

describe.skipIf(!LIVE)("agent LIVE (C2b) — goal real no runtime headless", () => {
  it("goal 'Responda somente: ok' completa com stdout ok", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "voicecast-live-"));
    try {
      const cfg = agentRunnerConfig();
      expect(cfg.runtime).toBe(true); // caminho novo do C2b (sem ZCODE_AGENT_BIN)
      const r = await runGoal({ id: "live-c2b", goal: "Responda somente: ok", cwd, timeoutMs: 180_000 }, cfg);
      console.log("[live-c2b]", JSON.stringify({ phase: r.phase, exitCode: r.exitCode, durationMs: r.durationMs, agentBin: cfg.agentBin }));
      console.log("[live-c2b] stdout:", JSON.stringify(r.stdout));
      if (r.stderrTail) console.log("[live-c2b] stderrTail:", JSON.stringify(r.stderrTail));
      expect(r.phase).toBe("completed");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().toLowerCase()).toContain("ok");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
