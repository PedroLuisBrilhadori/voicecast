/**
 * Agendamento do init da telemetria pós-ready — PURO (sem electron), testável
 * com fake timers (W2b).
 *
 * Histórico: o init esperava idle+15s porque o import do SDK OTel bloqueava o
 * event loop do main por ~9s (mitigação p/ não colidir com uma gravação).
 * Pós-W1 o SDK inteiro roda em worker_thread — o init não bloqueia mais nada,
 * então o delay inicial caiu p/ 2s (só p/ o arranque do app respirar). A
 * guarda de idle continua: se uma captura estiver em curso, adia e tenta de
 * novo (retry fixo) — init continua seguro em qualquer fase, mas não há
 * motivo p/ competir com o boot de uma sessão.
 */

/** Delay inicial pós-ready (era 15s — residual desnecessário pós-W1). */
export const TELEMETRY_INIT_DELAY_MS = 2_000;
/** Retry quando a captura não está idle (herdado do agendamento antigo). */
export const TELEMETRY_INIT_RETRY_MS = 5_000;

/**
 * Agenda `init` para rodar após `initialDelayMs`, esperando a captura ficar
 * idle (`getPhase() === "idle"`); não-idle → re-agenda a cada `retryDelayMs`.
 * Devolve o timer inicial (o caller pode clearTimeout no shutdown).
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
