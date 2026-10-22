/**
 * Lógica PURA do host do ASR (decisões e backoff) — sem electron/node imports,
 * testável no vitest. O lado com efeitos vive em src/main/asr-host.ts.
 */

export interface HostSnapshot {
  /** /health respondeu (porta aberta — mesmo em status loading)? */
  probeOk: boolean;
  /** nosso processo filho do serviço está vivo? */
  childRunning: boolean;
}

export type HostAction = "adopt" | "spawn" | "wait";

/** Decide a ação do supervisor diante do estado atual. */
export function hostAction(s: HostSnapshot): HostAction {
  if (s.childRunning) return "wait";
  return s.probeOk ? "adopt" : "spawn";
}

/**
 * Backoff de respawn por número de quedas: 1ª tentativa imediata, depois
 * 5s → 10s → 20s → 40s → 60s (teto).
 */
export function backoffDelayMs(crashes: number): number {
  if (crashes <= 0) return 0;
  return Math.min(5_000 * 2 ** (crashes - 1), 60_000);
}

/** O backoff zera depois de 60s de saúde estável. */
export function backoffShouldReset(stableMs: number): boolean {
  return stableMs >= 60_000;
}

// ── switch do modelo de transcrição (settings.json + env) ──────

export interface AsrSwitchSnapshot {
  /** env VOICECAST_ASR_HOST=0 (kill-switch de máquina — ganha de tudo). */
  envOff: boolean;
  /** settings.json `asrHost` — undefined = nunca tocado (default ligado). */
  settingsOn: boolean | undefined;
}

export type AsrSwitchSource = "env" | "settings" | "default";

/** Estado efetivo do switch: env desliga sempre; settings desliga por escolha do usuário. */
export function asrSwitch(s: AsrSwitchSnapshot): { enabled: boolean; source: AsrSwitchSource } {
  if (s.envOff) return { enabled: false, source: "env" };
  if (s.settingsOn === false) return { enabled: false, source: "settings" };
  return { enabled: true, source: "default" };
}
