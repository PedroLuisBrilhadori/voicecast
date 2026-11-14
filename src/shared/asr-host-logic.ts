/**
 * PURE logic of the ASR host (decisions and backoff) — no electron/node
 * imports, testable in vitest. The side with effects lives in
 * src/main/asr-host.ts.
 */

export interface HostSnapshot {
  /** did /health respond (port open — even with loading status)? */
  probeOk: boolean;
  /** is our service child process alive? */
  childRunning: boolean;
}

export type HostAction = "adopt" | "spawn" | "wait";

/** Decides the supervisor action given the current state. */
export function hostAction(s: HostSnapshot): HostAction {
  if (s.childRunning) return "wait";
  return s.probeOk ? "adopt" : "spawn";
}

/**
 * Respawn backoff by crash count: first attempt immediate, then
 * 5s → 10s → 20s → 40s → 60s (cap).
 */
export function backoffDelayMs(crashes: number): number {
  if (crashes <= 0) return 0;
  return Math.min(5_000 * 2 ** (crashes - 1), 60_000);
}

/** Backoff resets after 60s of stable health. */
export function backoffShouldReset(stableMs: number): boolean {
  return stableMs >= 60_000;
}

// ── transcription model switch (settings.json + env) ──────

export interface AsrSwitchSnapshot {
  /** env VOICECAST_ASR_HOST=0 (machine-level kill-switch — overrides everything). */
  envOff: boolean;
  /** settings.json `asrHost` — undefined = never touched (default on). */
  settingsOn: boolean | undefined;
}

export type AsrSwitchSource = "env" | "settings" | "default";

/** Effective switch state: env always disables; settings disables by user choice. */
export function asrSwitch(s: AsrSwitchSnapshot): { enabled: boolean; source: AsrSwitchSource } {
  if (s.envOff) return { enabled: false, source: "env" };
  if (s.settingsOn === false) return { enabled: false, source: "settings" };
  return { enabled: true, source: "default" };
}
