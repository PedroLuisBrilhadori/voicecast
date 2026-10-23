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
 * Kill-switch: VOICECAST_ASR_HOST=0 (env — ganha de tudo). Switch persistente
 * do usuário: settings.json `asrHost:false` (painel → "transcrição", IPC
 * asr:host-set) — desligar em runtime derruba o serviço na hora.
 * Com VOICECAST_ASR_URLS/VOICE_ASR_URLS configurado (endpoint externo), não
 * hospeda.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  asrSwitch,
  backoffDelayMs,
  backoffShouldReset,
  hostAction,
} from "../shared/asr-host-logic.js";
import type { AsrHostStatus } from "../shared/ipc.js";
import { readSettings, writeSettings } from "../shared/settings.js";
import { appDataDir } from "./storage.js";
import { logError, logInfo } from "./logging.js";

const PROBE_INTERVAL_MS = 20_000;

export function asrBackendDir(): string {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".local", "share");
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

/** Estado efetivo do switch do modelo de transcrição (env + settings + runtime). */
export function asrHostStatus(): AsrHostStatus {
  const sw = asrSwitch({
    envOff: process.env.VOICECAST_ASR_HOST === "0",
    settingsOn: readSettings(appDataDir()).asrHost,
  });
  return {
    enabled: sw.enabled,
    source: sw.source,
    external: Boolean(process.env.VOICECAST_ASR_URLS || process.env.VOICE_ASR_URLS),
    hosted: child !== null,
  };
}

/**
 * Liga/desliga o modelo de transcrição (persiste no settings.json). Desligar
 * derruba o serviço NA HORA (stopAsrHost — filho morto, monitor parado).
 * Ligar sobe o host (spawn com warmup em background). Com env
 * VOICECAST_ASR_HOST=0, o pedido de ligar é persistido mas o env segue
 * ganhando (status reflete).
 */
export async function setAsrHostEnabled(on: boolean): Promise<AsrHostStatus> {
  writeSettings(appDataDir(), { asrHost: on });
  logInfo(`ASR host: switch do usuário → ${on ? "LIGADO" : "DESLIGADO"} (settings.json)`);
  if (on) await ensureAsrHost();
  else stopAsrHost();
  return asrHostStatus();
}

/**
 * Pedido EXPLÍCITO de transcrição (F9 do ditado, botão "transcrever agora",
 * --transcribe) com o switch off → religa o modelo sozinho. Só quando o
 * desligamento veio do settings (escolha reversível); env
 * VOICECAST_ASR_HOST=0 é kill-switch de máquina e não é sobrescrito.
 * Retorna true quando religou.
 */
export async function asrAutoEnableIfNeeded(): Promise<boolean> {
  const st = asrHostStatus();
  if (st.enabled || st.source === "env") return false;
  logInfo("ASR host: pedido de transcrição com o switch off — religando o modelo");
  await setAsrHostEnabled(true);
  return true;
}

/** Dirs de libs CUDA das wheels nvidia pip (cublas/cudnn) no venv — o
 * ctranslate2 dlopen-as no primeiro uso e precisa de LD_LIBRARY_PATH. */
function cudaLibDirs(): string[] {
  try {
    const libRoot = path.join(asrBackendDir(), ".venv", "lib");
    const dirs: string[] = [];
    for (const py of fs.readdirSync(libRoot).filter((d) => d.startsWith("python"))) {
      const nvidia = path.join(libRoot, py, "site-packages", "nvidia");
      for (const pkg of fs.readdirSync(nvidia)) {
        for (const sub of ["lib", "lib64"]) {
          const dir = path.join(nvidia, pkg, sub);
          if (fs.existsSync(dir)) dirs.push(dir);
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

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
  // libcublas/libcudnn das wheels pip (senão o transcribe 500 com
  // "Library libcublas.so.12 is not found" — health diz cuda e a inferência
  // falha, achado 19/10)
  const cuda = cudaLibDirs();
  if (cuda.length) {
    env.LD_LIBRARY_PATH = [...cuda, env.LD_LIBRARY_PATH ?? ""]
      .filter(Boolean)
      .join(":");
  }
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

/** Sobe o host se for dele (chamado no whenReady; fail-soft — nunca derruba o app).
 * Chamadas concorrentes compartilham a mesma promessa (F9 e transcrição explícita
 * podem pedir junto — sem isso, dois spawns brigam pela porta). */
let ensureInProgress: Promise<void> | null = null;
export function ensureAsrHost(): Promise<void> {
  if (!ensureInProgress) {
    ensureInProgress = ensureAsrHostOnce().finally(() => {
      ensureInProgress = null;
    });
  }
  return ensureInProgress;
}

async function ensureAsrHostOnce(): Promise<void> {
  try {
    if (process.env.VOICECAST_ASR_URLS || process.env.VOICE_ASR_URLS) {
      logInfo("ASR host: VOICECAST_ASR_URLS/VOICE_ASR_URLS configurado — backend externo, não hospedo");
      return;
    }
    const sw = asrSwitch({
      envOff: process.env.VOICECAST_ASR_HOST === "0",
      settingsOn: readSettings(appDataDir()).asrHost,
    });
    if (!sw.enabled) {
      logInfo(
        sw.source === "env"
          ? "ASR host: desligado via VOICECAST_ASR_HOST=0"
          : "ASR host: desligado pelo usuário (settings.json asrHost=false) — sem modelo de transcrição",
      );
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
