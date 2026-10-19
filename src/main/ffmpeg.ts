/**
 * Resolução do ffmpeg: env > PATH > wsl.exe (ffmpeg do WSL acessa /mnt/c) >
 * imageio_ffmpeg do venv do voice-dictation. Testado com -version.
 * TUDO async — spawnSync congelava o processo principal no remux.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const pExec = promisify(execFile);

export interface Ffmpeg {
  cmd: string;
  isWsl: boolean;
}

let cached: Ffmpeg | null = null;

async function tryRun(cmd: string, args: string[]): Promise<boolean> {
  try {
    const r = await pExec(cmd, args, { timeout: 20_000 });
    return /ffmpeg version/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

function wslPathOf(winPath: string): string {
  const m = /^([A-Za-z]):[/\\](.*)$/.exec(winPath);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** Executa ffmpeg com args (paths Windows); traduz p/ WSL quando o resolved é wsl.exe. */
export async function runFfmpeg(ffmpeg: Ffmpeg, args: string[]): Promise<void> {
  if (!ffmpeg.isWsl) {
    try {
      await pExec(ffmpeg.cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(`ffmpeg falhou: ${(err.stderr || err.message || "").slice(-400)}`);
    }
    return;
  }
  const wslArgs = args.map((a) => wslPathOf(a) ?? a);
  try {
    await pExec("wsl.exe", ["-e", "ffmpeg", ...wslArgs], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`ffmpeg (wsl) falhou: ${(err.stderr || err.message || "").slice(-400)}`);
  }
}

export async function resolveFfmpeg(): Promise<Ffmpeg> {
  if (cached) return cached;

  const env = process.env.VOICECAST_FFMPEG;
  if (env && fs.existsSync(env)) {
    cached = { cmd: env, isWsl: false };
    return cached;
  }

  // Linux/Arch: ffmpeg do PATH (o where.exe abaixo é o lookup do Windows)
  if (await tryRun("ffmpeg", ["-version"])) {
    cached = { cmd: "ffmpeg", isWsl: false };
    return cached;
  }

  try {
    const r = await pExec("where.exe", ["ffmpeg"]);
    const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (first && fs.existsSync(first.trim())) {
      cached = { cmd: first.trim(), isWsl: false };
      return cached;
    }
  } catch {}

  if (await tryRun("wsl.exe", ["-e", "ffmpeg", "-version"])) {
    cached = { cmd: "wsl.exe", isWsl: true };
    return cached;
  }

  // último recurso: imageio_ffmpeg do venv do voice-dictation
  const py = path.join(
    process.env.LOCALAPPDATA ?? "",
    "voice-dictation",
    ".venv",
    "Scripts",
    "python.exe",
  );
  if (fs.existsSync(py)) {
    try {
      const rr = await pExec(
        py,
        ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"],
        { timeout: 30_000 },
      );
      const bin = (rr.stdout || "").trim().split(/\r?\n/).pop();
      if (bin && fs.existsSync(bin)) {
        cached = { cmd: bin, isWsl: false };
        return cached;
      }
    } catch {}
  }

  throw new Error(
    "ffmpeg não encontrado (env VOICECAST_FFMPEG, PATH, wsl.exe e imageio_ffmpeg do voice)",
  );
}
