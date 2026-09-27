/**
 * C4 — worker do cockpit (utilityProcess MOCK: porta fake no formato do
 * process.parentPort do Electron). Valida o PROTOCOLO de mensagens sem
 * electron: enqueue → sequência de goal-state pela porta, status, delegação
 * do enrich C3 (enrich-request/enrich-result), fail-soft sem resposta e a
 * telemetria do runner retransmitida ao main (mesmos nomes — sem duplicar
 * init do SDK no utilityProcess).
 *
 * O agente real é o fixture fake-agent.sh (mesmo padrão dos testes do C2/C3).
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

/** Porta MOCK no formato do process.parentPort do Electron (e.data). */
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
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condição do worker");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const goalStates = (port: Port): GoalState[] =>
  port.outbox.filter((m): m is Extract<AgentWorkerOutbound, { type: "goal-state" }> => m.type === "goal-state").map((m) => m.state);

/** Enriquecedor direto (sem round-trip) p/ testes que não exercem a delegação C3. */
const enrichDireto = async (goal: string) => ({ goal, included: false, contextChars: 0 });

// ---------------------------------------------------------------- testes

describe("agent-worker (protocolo pela porta MOCK)", () => {
  let cfg: RunnerConfig;

  beforeAll(() => {
    const bin = path.join(import.meta.dirname, "fixtures", "fake-agent.sh");
    execFileSync("chmod", ["+x", bin]);
    cfg = { enabled: true, agentBin: bin, timeoutMs: 10_000, direct: true };
  });

  it("enqueue → estados queued→running→completed pela porta, com saída do agente", async () => {
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

    // telemetria do runner retransmitida pela porta (mesmos nomes, sem SDK no
    // worker). O core lazy cacheia o instrumento no PRIMEIRO emit — em
    // produção ele nasce com o meter do ÚNICO worker do processo; aqui, com a
    // porta do primeiro teste do arquivo (mesma semântica de binding).
    expect(
      port.outbox.some(
        (m) => m.type === "telemetry" && m.kind === "counter" && m.name === "voicecast_agent_goals_total" && m.attrs?.desfecho === "completed",
      ),
    ).toBe(true);
    expect(
      port.outbox.some((m) => m.type === "telemetry" && m.kind === "histogram" && m.name === "voicecast_agent_goal_seconds"),
    ).toBe(true);
  });

  it("status devolve último estado + resumo da fila", async () => {
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
    expect(st?.summary).toBe("sem goals");
  });

  it("enrich C3 delegado ao main: enrich-request → enrich-result → contexto chega ao agente", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg }); // default: delega o enrich pela porta (produção)
    process.env.FAKE_ECHO_ARGS = "1";
    port.send({ type: "enqueue", req: { id: "w3", goal: "goal c/ contexto", cwd: os.tmpdir() } });

    await until(() => port.outbox.some((m) => m.type === "enrich-request"));
    const req = port.outbox.find((m): m is Extract<AgentWorkerOutbound, { type: "enrich-request" }> => m.type === "enrich-request");
    expect(req?.goal).toBe("goal c/ contexto"); // o goal ORIGINAL vai ao main (não o enriquecido)
    // o main responde com o goal enriquecido (goalContextEnricher roda lá)
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

  it("enrich sem resposta = fail-soft do C3: goal roda sem contexto, fila não trava", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrichTimeoutMs: 100 });
    process.env.FAKE_ECHO_ARGS = "1";
    port.send({ type: "enqueue", req: { id: "w4", goal: "goal sem resposta", cwd: os.tmpdir() } });

    await until(() => port.outbox.some((m) => m.type === "enrich-request"));
    // NÃO responde — timeout do delegante resolve o goal original
    await until(() => goalStates(port).some((s) => s.phase === "completed"));
    const done = goalStates(port)[goalStates(port).length - 1];
    expect(done.lastOutput).toContain("ok do agente");
    expect(done.lastOutput).not.toContain(SESSION_CONTEXT_BEGIN);
    delete process.env.FAKE_ECHO_ARGS;
  });

  it("recusa (goal vazio) vira estado sintético failed — a barra mostra o porquê", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w5", goal: "   ", cwd: os.tmpdir() } });

    await until(() => goalStates(port).some((s) => s.phase === "failed"));
    const failed = goalStates(port).find((s) => s.phase === "failed");
    expect(failed?.id).toBe("w5");
    expect(failed?.error).toBe("goal vazio");
  });

  it("bridge off no worker: failed sintético com o erro do kill-switch", async () => {
    const port = fakePort();
    runAgentWorker(port, { cfg: { ...cfg, enabled: false }, enrich: enrichDireto });
    port.send({ type: "enqueue", req: { id: "w6", goal: "g", cwd: os.tmpdir() } });

    await until(() => goalStates(port).some((s) => s.phase === "failed"));
    expect(goalStates(port)[0].error).toContain("VOICECAST_AGENT_BRIDGE");
  });

  it("fila serializa: dois goals enfileirados produzem dois desfechos completos", async () => {
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
