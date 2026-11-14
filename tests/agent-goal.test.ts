import { describe, expect, it } from "vitest";
import {
  createGoalState,
  goalSummary,
  isGoalFinal,
  transitionGoal,
  type GoalState,
} from "../src/shared/agent-goal";

/** Goal state machine (cockpit C2) — unique transitions and fail-soft. */
describe("agent-goal", () => {
  const base = () => createGoalState("g1", "abre um PR", "/tmp");

  it("queued → running records startedAt", () => {
    const s = transitionGoal(base(), { type: "start" });
    expect(s.phase).toBe("running");
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it("output only in running; keeps 4k text tail", () => {
    const run = transitionGoal(base(), { type: "start" });
    expect(transitionGoal(base(), { type: "output", text: "x" }).lastOutput).toBeNull();
    const out = transitionGoal(run, { type: "output", text: "y".repeat(5000) });
    expect(out.lastOutput).toHaveLength(4000);
  });

  it("finish validates phase and records error/outcome", () => {
    const run = transitionGoal(base(), { type: "start" });
    const done = transitionGoal(run, { type: "finish", phase: "failed", error: "boom" });
    expect(done.phase).toBe("failed");
    expect(done.error).toBe("boom");
    expect(done.endedAt).toBeGreaterThan(0);
    // finish outside running is ignored
    expect(transitionGoal(done, { type: "finish", phase: "completed" }).phase).toBe("failed");
  });

  it("cancel in any live phase; ignored in final phase", () => {
    expect(transitionGoal(base(), { type: "cancel" }).phase).toBe("cancelled");
    const done: GoalState = { ...base(), phase: "completed", endedAt: 1 };
    expect(transitionGoal(done, { type: "cancel" }).phase).toBe("completed");
  });

  it("isGoalFinal and goalSummary cover all phases", () => {
    expect(isGoalFinal("completed")).toBe(true);
    expect(isGoalFinal("running")).toBe(false);
    const run = transitionGoal(base(), { type: "start" });
    expect(goalSummary(run)).toContain("running");
    expect(goalSummary(base())).toBe("goal queued");
    expect(goalSummary({ ...run, phase: "failed", error: "x" })).toContain("x");
  });
});
