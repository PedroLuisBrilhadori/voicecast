/**
 * Persistent app settings (settings.json in appDataDir) — PURE module
 * (fs only, no electron), testable in vitest. The side with effects (real
 * path, IPC) lives in src/main/asr-host.ts and index.ts.
 *
 * Known keys:
 * - `asrHost` (boolean, default true): toggles the local transcription model
 *   (the ASR host). Env VOICECAST_ASR_HOST=0 overrides settings.
 */
import fs from "node:fs";

export interface AppSettings {
  asrHost?: boolean;
}

export function settingsFile(dir: string): string {
  return `${dir}/settings.json`;
}

/** Fail-soft read: missing or corrupted file → {} (defaults apply). */
export function readSettings(dir: string): AppSettings {
  try {
    const raw = fs.readFileSync(settingsFile(dir), "utf-8");
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as AppSettings) : {};
  } catch {
    return {};
  }
}

/** Merge + atomic write (tmp+rename) — never truncates the existing file. */
export function writeSettings(dir: string, patch: AppSettings): AppSettings {
  const merged = { ...readSettings(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${settingsFile(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, settingsFile(dir));
  return merged;
}
