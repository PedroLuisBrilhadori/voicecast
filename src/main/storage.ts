/**
 * Storage da aplicação — layout de dados em %LOCALAPPDATA%\voicecast (win)
 * ou ${XDG_DATA_HOME:-~/.local/share}/voicecast (linux). Sempre por aqui;
 * nenhum módulo monta path diretamente (padrão voice-dictation).
 */
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

export function appDataDir(): string {
  return path.join(app.getPath("userData"), "..", "voicecast");
}

export function sessionsRoot(): string {
  return path.join(appDataDir(), "sessions");
}

export interface SessionDirs {
  root: string;
  video: string; // original.fmp4 (bruto do MediaRecorder)
  mp4: string; // session.mp4 (remux faststart)
  audio: string; // audio.webm (ditado — sem vídeo)
  meta: string; // meta.json
  transcript: string; // transcript.json
  clips: string;
  frames: string;
  thumbs: string;
}

export function sessionDirs(dayDir: string, name: string): SessionDirs {
  const root = path.join(sessionsRoot(), dayDir, name);
  return {
    root,
    video: path.join(root, "original.fmp4"),
    mp4: path.join(root, "session.mp4"),
    audio: path.join(root, "audio.webm"),
    meta: path.join(root, "meta.json"),
    transcript: path.join(root, "transcript.json"),
    clips: path.join(root, "clips"),
    frames: path.join(root, "frames"),
    thumbs: path.join(root, "thumbs"),
  };
}

/** Garante a árvore de diretórios (chamado no boot). Idempotente. */
export function ensureLayout(): void {
  for (const dir of [appDataDir(), sessionsRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
