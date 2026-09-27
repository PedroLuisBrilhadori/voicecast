import { describe, expect, it } from "vitest";
import {
  createGoalState,
  goalSummary,
  isGoalFinal,
  transitionGoal,
  type GoalState,
} from "../src/shared/agent-goal";

/** Máquina de estados do goal (cockpit C2) — transições únicas e fail-soft. */
describe("agent-goal", () => {
  const base = () => createGoalState("g1", "abre um PR", "/tmp");

  it("queued → running registra startedAt", () => {
    const s = transitionGoal(base(), { type: "start" });
    expect(s.phase).toBe("running");
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it("output só em running; guarda cauda do texto (4k)", () => {
    const run = transitionGoal(base(), { type: "start" });
    expect(transitionGoal(base(), { type: "output", text: "x" }).lastOutput).toBeNull();
    const out = transitionGoal(run, { type: "output", text: "y".repeat(5000) });
    expect(out.lastOutput).toHaveLength(4000);
  });

  it("finish valida fase e grava erro/desfecho", () => {
    const run = transitionGoal(base(), { type: "start" });
    const done = transitionGoal(run, { type: "finish", phase: "failed", error: "boom" });
    expect(done.phase).toBe("failed");
    expect(done.error).toBe("boom");
    expect(done.endedAt).toBeGreaterThan(0);
    // finish fora de running é ignorado
    expect(transitionGoal(done, { type: "finish", phase: "completed" }).phase).toBe("failed");
  });

  it("cancel em qualquer fase viva; ignorado em fase final", () => {
    expect(transitionGoal(base(), { type: "cancel" }).phase).toBe("cancelled");
    const done: GoalState = { ...base(), phase: "completed", endedAt: 1 };
    expect(transitionGoal(done, { type: "cancel" }).phase).toBe("completed");
  });

  it("isGoalFinal e goalSummary cobrem todas as fases", () => {
    expect(isGoalFinal("completed")).toBe(true);
    expect(isGoalFinal("running")).toBe(false);
    const run = transitionGoal(base(), { type: "start" });
    expect(goalSummary(run)).toContain("rodando");
    expect(goalSummary(base())).toBe("goal na fila");
    expect(goalSummary({ ...run, phase: "failed", error: "x" })).toContain("x");
  });
});
