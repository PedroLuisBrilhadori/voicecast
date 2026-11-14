import { describe, expect, it } from "vitest";
import {
  asrSwitch,
  backoffDelayMs,
  backoffShouldReset,
  hostAction,
} from "../src/shared/asr-host-logic";

describe("hostAction", () => {
  it("child alive → wait (nothing to do)", () => {
    expect(hostAction({ probeOk: true, childRunning: true })).toBe("wait");
    expect(hostAction({ probeOk: false, childRunning: true })).toBe("wait");
  });
  it("child dead + port responding → adopt (never duplicates)", () => {
    expect(hostAction({ probeOk: true, childRunning: false })).toBe("adopt");
  });
  it("child dead + port dead → spawn", () => {
    expect(hostAction({ probeOk: false, childRunning: false })).toBe("spawn");
  });
});

describe("backoffDelayMs", () => {
  it("first attempt is immediate", () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
  it("progression 5s → 10s → 20s → 40s with a 60s cap", () => {
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(10_000);
    expect(backoffDelayMs(3)).toBe(20_000);
    expect(backoffDelayMs(4)).toBe(40_000);
    expect(backoffDelayMs(5)).toBe(60_000);
    expect(backoffDelayMs(50)).toBe(60_000);
  });
});

describe("backoffShouldReset", () => {
  it("resets after 60s stable", () => {
    expect(backoffShouldReset(59_999)).toBe(false);
    expect(backoffShouldReset(60_000)).toBe(true);
  });
});

describe("asrSwitch (transcription model on/off)", () => {
  it("env VOICECAST_ASR_HOST=0 wins over everything", () => {
    expect(asrSwitch({ envOff: true, settingsOn: true }).enabled).toBe(false);
    expect(asrSwitch({ envOff: true, settingsOn: true }).source).toBe("env");
    expect(asrSwitch({ envOff: true, settingsOn: undefined }).source).toBe("env");
  });
  it("settings asrHost:false turns it off (settings source)", () => {
    const r = asrSwitch({ envOff: false, settingsOn: false });
    expect(r.enabled).toBe(false);
    expect(r.source).toBe("settings");
  });
  it("no env and no settings (or asrHost:true) → on", () => {
    expect(asrSwitch({ envOff: false, settingsOn: undefined })).toEqual({ enabled: true, source: "default" });
    expect(asrSwitch({ envOff: false, settingsOn: true })).toEqual({ enabled: true, source: "default" });
  });
});
