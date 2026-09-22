import { describe, expect, it } from "vitest";
import { backoffDelayMs, backoffShouldReset, hostAction } from "../src/shared/asr-host-logic";

describe("hostAction", () => {
  it("filho vivo → wait (nada a fazer)", () => {
    expect(hostAction({ probeOk: true, childRunning: true })).toBe("wait");
    expect(hostAction({ probeOk: false, childRunning: true })).toBe("wait");
  });
  it("filho morto + porta respondendo → adopt (nunca duplica)", () => {
    expect(hostAction({ probeOk: true, childRunning: false })).toBe("adopt");
  });
  it("filho morto + porta morta → spawn", () => {
    expect(hostAction({ probeOk: false, childRunning: false })).toBe("spawn");
  });
});

describe("backoffDelayMs", () => {
  it("primeira tentativa é imediata", () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
  it("progressão 5s → 10s → 20s → 40s com teto de 60s", () => {
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(10_000);
    expect(backoffDelayMs(3)).toBe(20_000);
    expect(backoffDelayMs(4)).toBe(40_000);
    expect(backoffDelayMs(5)).toBe(60_000);
    expect(backoffDelayMs(50)).toBe(60_000);
  });
});

describe("backoffShouldReset", () => {
  it("zera depois de 60s estável", () => {
    expect(backoffShouldReset(59_999)).toBe(false);
    expect(backoffShouldReset(60_000)).toBe(true);
  });
});
