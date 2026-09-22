/**
 * Host do ASR local — o app spawna e supervisiona o serviço python
 * vendorizado (asr-backend/, instalado em %LOCALAPPDATA%\voicecast\asr-backend
 * pelo scripts/setup-asr-backend.ps1). O voicecast deixou de depender do
 * serviço compartilhado do voice-dictation (aposentado em 2026-09-22): o
 * backend agora é nosso — o acesso continua via HTTP :8701, cliente
 * inalterado (src/main/asr.ts, com failover de URLs).
 *
 * Regras: probe de /health antes de qualquer spawn (nunca duplica serviço que
 * já responde — inclusive um externo, que é adotado), respawn com backoff
 * 5s→60s resetando após 60s estável, logs do filho em logs/asr-backend.log.
 * Kill-switch: VOICECAST_ASR_HOST=0. Com VOICECAST_ASR_URLS/VOICE_ASR_URLS
 * configurado (endpoint externo), não hospeda.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { backoffDelayMs, backoffShouldReset, hostAction } from "../shared/asr-host-logic.js";
import { logError, logInfo } from "./logging.js";

const PROBE_INTERVAL_MS = 20_000;

export function asrBackendDir(): string {
  const base =
    process.env.LOCALAPPDATA ??
    path.join(process.env.USERPROFILE ?? "", ".local", "share");
  return path.join(base, "voicecast", "asr-backend");
}

export function backendPython(): string | null {
  const py = path.join(
    asrBackendDir(),
    ".venv",
    process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
  );
  return fs.existsSync(py) ? py : null;
}

export function backendSrc(): string | null {
  const src = path.join(asrBackendDir(), "src");
  return fs.existsSync(path.join(src, "voice")) ? src : null;
}

export function asrPort(): number {
  return Number(process.env.VOICECAST_ASR_PORT ?? 8701);
}

async function probeHealth(timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${asrPort()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function childLogFile(): string {
  const dir = path.join(app.getPath("userData"), "..", "voicecast", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "asr-backend.log");
}

let child: ChildProcess | null = null;
let crashes = 0;
let stableSince = 0;
let monitor: ReturnType<typeof setInterval> | null = null;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;

function spawnBackend(): void {
  const py = backendPython();
  const src = backendSrc();
  if (!py || !src) return;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: src,
    VOICE_APP_DIR: asrBackendDir(),
    VOICE_ASR_MODEL: process.env.VOICE_ASR_MODEL ?? "large-v3-turbo",
    OTEL_ENABLED: "0", // venv próprio não instala deps OTel; telemetria do serviço fica off
  };
  const logFd = fs.openSync(childLogFile(), "a");
  child = spawn(py, ["-m", "voice.asr_service", "--port", String(asrPort())], {
    cwd: asrBackendDir(),
    env,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  logInfo(`ASR host: serviço de pé (pid ${child.pid}, porta ${asrPort()})`);
  child.on("exit", (code) => {
    child = null;
    crashes += 1;
    logError(`ASR host: serviço saiu (code ${code}) — respawn em ${backoffDelayMs(crashes)}ms`);
    scheduleRespawn();
  });
}

function scheduleRespawn(): void {
  if (respawnTimer) return;
  respawnTimer = setTimeout(
    () => {
      respawnTimer = null;
      void (async () => {
        // nunca duplica: se algo já responde na porta, adota
        if (await probeHealth()) {
          logInfo("ASR host: serviço externo responde na porta — adotado, sem spawn");
          return;
        }
        if (hostAction({ probeOk: false, childRunning: child !== null }) === "spawn") {
          spawnBackend();
        }
      })();
    },
    backoffDelayMs(crashes),
  );
}

function startMonitor(): void {
  if (monitor) return;
  monitor = setInterval(() => {
    void (async () => {
      const ok = await probeHealth();
      if (ok) {
        if (!stableSince) {
          stableSince = Date.now();
        } else if (crashes > 0 && backoffShouldReset(Date.now() - stableSince)) {
          logInfo("ASR host: 60s estável — backoff zerado");
          crashes = 0;
        }
        return;
      }
      stableSince = 0;
      if (hostAction({ probeOk: false, childRunning: child !== null }) === "spawn") {
        scheduleRespawn();
      }
    })();
  }, PROBE_INTERVAL_MS);
}

/** Sobe o host se for dele (chamado no whenReady; fail-soft — nunca derruba o app). */
export async function ensureAsrHost(): Promise<void> {
  try {
    if (process.env.VOICECAST_ASR_URLS || process.env.VOICE_ASR_URLS) {
      logInfo("ASR host: VOICECAST_ASR_URLS/VOICE_ASR_URLS configurado — backend externo, não hospedo");
      return;
    }
    if (process.env.VOICECAST_ASR_HOST === "0") {
      logInfo("ASR host: desligado via VOICECAST_ASR_HOST=0");
      return;
    }
    if (!backendPython() || !backendSrc()) {
      logError(
        "ASR host: backend não instalado — rode scripts/setup-asr-backend.ps1 " +
          "(transcrição/ditado ficam sem backend local)",
      );
      return;
    }
    if (await probeHealth()) {
      logInfo("ASR host: serviço já responde na porta — adotado, sem spawn");
      startMonitor();
      return;
    }
    spawnBackend();
    startMonitor();
  } catch (e) {
    logError("ASR host: falha ao subir (fail-soft):", e);
  }
}

export function stopAsrHost(): void {
  if (monitor) clearInterval(monitor);
  monitor = null;
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  if (child) {
    logInfo(`ASR host: encerrando serviço (pid ${child.pid})`);
    child.kill();
    child = null;
  }
}
