/**
 * Helpers de path puros (sem Electron) — testáveis em qualquer SO.
 */

const WIN_DRIVE = /^([A-Za-z]):[/\\](.*)$/;

/**
 * Converte path Windows para o equivalente WSL (/mnt/c/...).
 * Usado pelo gerador de contexto ("Copiar para o ZCode") — o agente roda no
 * WSL e precisa ler os artefatos da sessão gravados no disco do Windows.
 */
export function winPathToWsl(p: string): string {
  const m = WIN_DRIVE.exec(p);
  if (!m) return p;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${drive}/${rest}`;
}

/** Igual ao acima, mas com aspas quando o path tem espaço (para colar em markdown). */
export function wslPathQuoted(p: string): string {
  const wsl = winPathToWsl(p);
  return /\s/.test(wsl) ? `"${wsl}"` : wsl;
}

/**
 * Nome de diretório de sessão: <hhmm>-<hash8> — legível e único.
 * hash determinístico a partir de chave estável (evita colisão no mesmo minuto).
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
