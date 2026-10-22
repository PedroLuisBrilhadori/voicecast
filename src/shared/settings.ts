/**
 * Settings persistente do app (settings.json no appDataDir) — módulo PURO
 * (só fs, sem electron), testável no vitest. O lado com efeitos (path real,
 * IPC) vive em src/main/asr-host.ts e index.ts.
 *
 * Chaves conhecidas:
 * - `asrHost` (boolean, default true): liga/desliga o modelo de transcrição
 *   local (host do ASR). O env VOICECAST_ASR_HOST=0 ganha do settings.
 */
import fs from "node:fs";

export interface AppSettings {
  asrHost?: boolean;
}

export function settingsFile(dir: string): string {
  return `${dir}/settings.json`;
}

/** Leitura fail-soft: arquivo ausente ou corrompido → {} (defaults valem). */
export function readSettings(dir: string): AppSettings {
  try {
    const raw = fs.readFileSync(settingsFile(dir), "utf-8");
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as AppSettings) : {};
  } catch {
    return {};
  }
}

/** Merge + escrita atômica (tmp+rename) — nunca trunca o arquivo existente. */
export function writeSettings(dir: string, patch: AppSettings): AppSettings {
  const merged = { ...readSettings(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${settingsFile(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, settingsFile(dir));
  return merged;
}
