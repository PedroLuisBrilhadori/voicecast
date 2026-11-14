/**
 * Local ASR host — the app spawns and supervises the vendored python
 * service (asr-backend/, installed at %LOCALAPPDATA%\voicecast\asr-backend
 * by scripts/setup-asr-backend.ps1). voicecast stopped depending on the
 * shared voice-dictation service (retired on 2026-09-22): the
 * backend is ours now — access is still via HTTP :8701, unchanged
 * client (src/main/asr.ts, with URL failover).
 *
 * Rules: /health probe before any spawn (never duplicates a service that
 * already answers — including an external one, which is adopted), respawn with backoff
 * 5s→60s resetting after 60s stable, child logs at logs/asr-backend.log.
 * Kill-switch: VOICECAST_ASR_HOST=0 (env — wins over everything). Persistent
 * user switch: settings.json `asrHost:false` (panel → "transcription", IPC
 * asr:host-set) — turning it off at runtime takes the service down right away.
 * With VOICECAST_ASR_URLS/VOICE_ASR_URLS configured (external endpoint), it
 * doesn't host.
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

/** Effective state of the transcription model switch (env + settings + runtime). */
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
 * Turns the transcription model on/off (persists to settings.json). Turning it off
 * takes the service down RIGHT AWAY (stopAsrHost — child killed, monitor stopped).
 * Turning it on brings the host up (spawn with background warmup). With env
 * VOICECAST_ASR_HOST=0, the on request is persisted but the env keeps
 * winning (status reflects it).
 */
export async function setAsrHostEnabled(on: boolean): Promise<AsrHostStatus> {
  writeSettings(appDataDir(), { asrHost: on });
  logInfo(`ASR host: user switch → ${on ? "ON" : "OFF"} (settings.json)`);
  if (on) await ensureAsrHost();
  else stopAsrHost();
  return asrHostStatus();
}

/**
 * EXPLICIT transcription request (F9 dictation, "transcrever agora" button,
 * --transcribe) with the switch off → turns the model back on by itself. Only when the
 * shutdown came from settings (reversible choice); env
 * VOICECAST_ASR_HOST=0 is a machine-level kill-switch and is not overridden.
 * Returns true when it re-enabled.
 */
export async function asrAutoEnableIfNeeded(): Promise<boolean> {
  const st = asrHostStatus();
  if (st.enabled || st.source === "env") return false;
  logInfo("ASR host: transcription request with the switch off — re-enabling the model");
  await setAsrHostEnabled(true);
  return true;
}

/** CUDA lib dirs of the pip nvidia wheels (cublas/cudnn) in the venv —
 * ctranslate2 dlopens them on first use and needs LD_LIBRARY_PATH. */
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
    OTEL_ENABLED: "0", // own venv doesn't install OTel deps; service telemetry stays off
  };
  // libcublas/libcudnn from the pip wheels (otherwise transcribe 500s with
  // "Library libcublas.so.12 is not found" — health says cuda but inference
  // fails, finding from 19/10)
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
  logInfo(`ASR host: service up (pid ${child.pid}, port ${asrPort()})`);
  child.on("exit", (code) => {
    child = null;
    crashes += 1;
    logError(`ASR host: service exited (code ${code}) — respawn in ${backoffDelayMs(crashes)}ms`);
    scheduleRespawn();
  });
}

function scheduleRespawn(): void {
  if (respawnTimer) return;
  respawnTimer = setTimeout(
    () => {
      respawnTimer = null;
      void (async () => {
        // never duplicate: if something already answers on the port, adopt it
        if (await probeHealth()) {
          logInfo("ASR host: external service answering on the port — adopted, no spawn");
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
          logInfo("ASR host: 60s stable — backoff reset");
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

/** Brings the host up if it's on it (called on whenReady; fail-soft — never takes the app down).
 * Concurrent calls share the same promise (F9 and explicit transcription
 * may ask together — without this, two spawns fight over the port). */
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
      logInfo("ASR host: VOICECAST_ASR_URLS/VOICE_ASR_URLS configured — external backend, not hosting");
      return;
    }
    const sw = asrSwitch({
      envOff: process.env.VOICECAST_ASR_HOST === "0",
      settingsOn: readSettings(appDataDir()).asrHost,
    });
    if (!sw.enabled) {
      logInfo(
        sw.source === "env"
          ? "ASR host: off via VOICECAST_ASR_HOST=0"
          : "ASR host: off by the user (settings.json asrHost=false) — no transcription model",
      );
      return;
    }
    if (!backendPython() || !backendSrc()) {
      logError(
        "ASR host: backend not installed — run scripts/setup-asr-backend.ps1 " +
          "(transcription/dictation stay without a local backend)",
      );
      return;
    }
    if (await probeHealth()) {
      logInfo("ASR host: service already answering on the port — adopted, no spawn");
      startMonitor();
      return;
    }
    spawnBackend();
    startMonitor();
  } catch (e) {
    logError("ASR host: failed to start (fail-soft):", e);
  }
}

export function stopAsrHost(): void {
  if (monitor) clearInterval(monitor);
  monitor = null;
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  if (child) {
    logInfo(`ASR host: shutting down service (pid ${child.pid})`);
    child.kill();
    child = null;
  }
}
