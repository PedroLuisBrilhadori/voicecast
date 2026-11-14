/**
 * Pure path helpers (no Electron) — testable on any OS.
 */

const WIN_DRIVE = /^([A-Za-z]):[/\\](.*)$/;

/**
 * Converts a Windows path to its WSL equivalent (/mnt/c/...).
 * Used by the context generator ("Copy to ZCode") — the agent runs inside
 * WSL and needs to read the session artifacts written to the Windows disk.
 */
export function winPathToWsl(p: string): string {
  const m = WIN_DRIVE.exec(p);
  if (!m) return p;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${drive}/${rest}`;
}

/** Same as above, but quoted when the path has spaces (for pasting into markdown). */
export function wslPathQuoted(p: string): string {
  const wsl = winPathToWsl(p);
  return /\s/.test(wsl) ? `"${wsl}"` : wsl;
}

/**
 * Session directory name: <hhmm>-<hash8> — readable and unique.
 * Deterministic hash from a stable key (avoids collision within the same minute).
 */
export function sessionDirName(
  now: Date,
  seed: string,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hash = (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  return `${hhmm}-${hash}`;
}
