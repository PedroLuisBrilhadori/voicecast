/**
 * C4 — cockpit worker (MOCK utilityProcess: fake port in Electron's
 * process.parentPort format). Validates the message PROTOCOL without
 * electron: enqueue → goal-state sequence over the port, status, C3 enrich
 * delegation (enrich-request/enrich-result), fail-soft without response and
 * runner telemetry relayed to main (same names — no duplicate SDK init in
 * the utilityProcess).
 *
 * The real agent is the fake-agent.sh fixture (same pattern as the C2/C3 tests).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runAgentWorker } from "../src/main/agent/worker";
import type { AgentWorkerInbound, AgentWorkerOutbound } from "../src/shared/agent-worker-protocol";
import type { GoalState } from "../src/shared/agent-goal";
import { SESSION_CONTEXT_BEGIN, SESSION_CONTEXT_END } from "../src/shared/agent-context";
import type { RunnerConfig } from "../src/main/agent/runner";

// ---------------------------------------------------------------- fakes

type Port = ReturnType<typeof fakePort>;

/** MOCK port in Electron's process.parentPort format (e.data). */
function fakePort() {
  const outbox: AgentWorkerOutbound[] = [];
  const listeners: ((e: { data: AgentWorkerInbound }) => void)[] = [];
  return {
    outbox,
    on(_ev: "message", cb: (e: { data: AgentWorkerInbound }) => void): void {
      listeners.push(cb);
    },
    postMessage(m: AgentWorkerOutbound): void {
      outbox.push(m);
    },
    send(m: AgentWorkerInbound): void {
      for (const cb of listeners) cb({ data: m });
    },
  };
}

async function until(cond: () => boolean, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for worker condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const goalStates = (port: Port): GoalState[] =>
  port.outbox.filter((m): m is Extract<AgentWorkerOutbound, { type: "goal-state" }> => m.type === "goal-state").map((m) => m.state);

/** Direct enricher (no round-trip) for tests that don't exercise C3 delegation. */
const enrichDireto = async (goal: string) => ({ goal, included: false, contextChars: 0 });

// ---------------------------------------------------------------- tests

describe("agent-worker (protocol over the MOCK port)", () => {
  let cfg: RunnerConfig;

  beforeAll(() => {
    const bin = path.join(import.meta.dirname, "fixtures", "fake-agent.sh");
    execFileSync("chmod", ["+x", bin]);
    cfg = { enabled: true, agentBin: bin, timeoutMs: 10_000, direct: true };
  });

  it("enqueue → queued→running→completed states over the port, with agent output", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w1", goal: "goal do worker", cwd: os.tmpdir() } });

    await until(() => goalStates(port).some((s) => s.phase === "completed"));
    const phases = goalStates(port).map((s) => s.phase);
    expect(phases[0]).toBe("queued");
    expect(phases).toContain("running");
    expect(phases[phases.length - 1]).toBe("completed");

    const done = goalStates(port)[goalStates(port).length - 1];
    expect(done.id).toBe("w1");
    expect(done.goal).toBe("goal do worker");
    expect(done.cwd).toBe(os.tmpdir());
    expect(done.lastOutput).toContain("ok do agente");
    expect(done.error).toBeNull();

    // runner telemetry relayed over the port (same names, no SDK in the
    // worker). The lazy core caches the instrument on the FIRST emit — in
    // production it's born with the meter of the process's ONLY worker; here,
    // with the port of the file's first test (same binding semantics).
    expect(
      port.outbox.some(
        (m) => m.type === "telemetry" && m.kind === "counter" && m.name === "voicecast_agent_goals_total" && m.attrs?.desfecho === "completed",
      ),
    ).toBe(true);
    expect(
      port.outbox.some((m) => m.type === "telemetry" && m.kind === "histogram" && m.name === "voicecast_agent_goal_seconds"),
    ).toBe(true);
  });

  it("status returns last state + queue summary", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w2", goal: "g", cwd: os.tmpdir() } });
    await until(() => goalStates(port).some((s) => s.phase === "completed"));

    port.send({ type: "status" });
    await until(() => port.outbox.some((m) => m.type === "status"));
    const st = port.outbox.find((m): m is Extract<AgentWorkerOutbound, { type: "status" }> => m.type === "status");
    expect(st?.state?.phase).toBe("completed");
    expect(st?.state?.id).toBe("w2");
    expect(st?.size).toBe(0);
    expect(st?.summary).toBe("no goals");
  });

  it("C3 enrich delegated to main: enrich-request → enrich-result → context reaches the agent", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg }); // default: delegates enrich over the port (production)
    process.env.FAKE_ECHO_ARGS = "1";
    port.send({ type: "enqueue", req: { id: "w3", goal: "goal c/ contexto", cwd: os.tmpdir() } });

    await until(() => port.outbox.some((m) => m.type === "enrich-request"));
    const req = port.outbox.find((m): m is Extract<AgentWorkerOutbound, { type: "enrich-request" }> => m.type === "enrich-request");
    expect(req?.goal).toBe("goal c/ contexto"); // the ORIGINAL goal goes to main (not the enriched one)
    // main responds with the enriched goal (goalContextEnricher runs there)
    port.send({
      type: "enrich-result",
      rid: req!.rid,
      result: {
        goal: `${req!.goal}\n\n${SESSION_CONTEXT_BEGIN}\nctx pela ponte\n${SESSION_CONTEXT_END}`,
        included: true,
        contextChars: 15,
      },
    });

    await until(() => goalStates(port).some((s) => s.phase === "completed"));
    const done = goalStates(port)[goalStates(port).length - 1];
    expect(done.lastOutput).toContain(SESSION_CONTEXT_BEGIN);
    expect(done.lastOutput).toContain("ctx pela ponte");
    expect(done.lastOutput).toContain(SESSION_CONTEXT_END);
    delete process.env.FAKE_ECHO_ARGS;
  });

  it("enrich without response = C3 fail-soft: goal runs without context, queue doesn't jam", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrichTimeoutMs: 100 });
    process.env.FAKE_ECHO_ARGS = "1";
    port.send({ type: "enqueue", req: { id: "w4", goal: "goal sem resposta", cwd: os.tmpdir() } });

    await until(() => port.outbox.some((m) => m.type === "enrich-request"));
    // does NOT respond — delegator timeout resolves the original goal
    await until(() => goalStates(port).some((s) => s.phase === "completed"));
    const done = goalStates(port)[goalStates(port).length - 1];
    expect(done.lastOutput).toContain("ok do agente");
    expect(done.lastOutput).not.toContain(SESSION_CONTEXT_BEGIN);
    delete process.env.FAKE_ECHO_ARGS;
  });

  it("rejection (empty goal) becomes a synthetic failed state — the bar shows why", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w5", goal: "   ", cwd: os.tmpdir() } });

    await until(() => goalStates(port).some((s) => s.phase === "failed"));
    const failed = goalStates(port).find((s) => s.phase === "failed");
    expect(failed?.id).toBe("w5");
    expect(failed?.error).toBe("empty goal");
  });

  it("bridge off in the worker: synthetic failed with the kill-switch error", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg: { ...cfg, enabled: false }, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w6", goal: "g", cwd: os.tmpdir() } });

    await until(() => goalStates(port).some((s) => s.phase === "failed"));
    expect(goalStates(port)[0].error).toContain("VOICECAST_AGENT_BRIDGE");
  });

  it("queue serializes: two enqueued goals produce two complete outcomes", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "q1", goal: "primeiro", cwd: os.tmpdir() } });
    port.send({ type: "enqueue", req: { id: "q2", goal: "segundo", cwd: os.tmpdir() } });

    await until(() => goalStates(port).filter((s) => s.phase === "completed").length >= 2);
    const ids = goalStates(port).filter((s) => s.phase === "completed").map((s) => s.id);
    expect(ids).toContain("q1");
    expect(ids).toContain("q2");
  });
});
