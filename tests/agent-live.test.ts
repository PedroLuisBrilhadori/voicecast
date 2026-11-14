import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRunnerConfig, runGoal } from "../src/main/agent/runner";

/**
 * LIVE test of C2b — continuous proof of the U2 unlock: a REAL goal running
 * end to end via runGoal on the runtime's built CLI (U1) with its own
 * auto-curated data-dir (identity keys).
 *
 * ONLY runs with VOICECAST_AGENT_LIVE=1 (CI/dev default = skip — no network,
 * no cost, doesn't touch ~/.zcode beyond what the CLI writes to ~/.zcode/cli/).
 *
 * Requirements: /tmp/zcode-cli-build (U1) + ~/.zcode/v2/credentials.json
 * (desktop login). Expected evidence: stdout "ok", phase=completed.
 */
const LIVE = process.env.VOICECAST_AGENT_LIVE === "1";

describe.skipIf(!LIVE)("agent LIVE (C2b) — real goal on the headless runtime", () => {
  it("goal 'Responda somente: ok' completes with stdout ok", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "voicecast-live-"));
    try {
      const cfg = agentRunnerConfig();
      expect(cfg.runtime).toBe(true); // new C2b path (no ZCODE_AGENT_BIN)
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
