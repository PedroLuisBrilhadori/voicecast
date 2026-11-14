/**
 * Telemetry init scheduling post-ready — PURE (no electron), testable with
 * fake timers (W2b).
 *
 * History: init used to wait for idle+15s because the OTel SDK import blocked
 * the main event loop for ~9s (mitigation to avoid colliding with a recording).
 * Post-W1 the whole SDK runs in a worker_thread — init no longer blocks
 * anything, so the initial delay dropped to 2s (just to let the app boot
 * breathe). The idle guard remains: if a capture is in progress, it delays and
 * retries (fixed retry) — init stays safe at any phase, but there is no reason
 * to compete with a session's boot.
 */

/** Initial delay post-ready (was 15s — unnecessary leftover post-W1). */
export const TELEMETRY_INIT_DELAY_MS = 2_000;
/** Retry when the capture is not idle (inherited from the old scheduling). */
export const TELEMETRY_INIT_RETRY_MS = 5_000;

/**
 * Schedules `init` to run after `initialDelayMs`, waiting for the capture to
 * be idle (`getPhase() === "idle"`); not idle → reschedules every
 * `retryDelayMs`. Returns the initial timer (the caller may clearTimeout on
 * shutdown).
 */
export function scheduleTelemetryInit(
  getPhase: () => string,
  init: () => void,
  initialDelayMs: number = TELEMETRY_INIT_DELAY_MS,
  retryDelayMs: number = TELEMETRY_INIT_RETRY_MS,
): NodeJS.Timeout {
  const attempt = (): void => {
    if (getPhase() !== "idle") {
      setTimeout(attempt, retryDelayMs);
      return;
    }
    init();
  };
  return setTimeout(attempt, initialDelayMs);
}
