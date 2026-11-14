/**
 * Application storage — data layout at %LOCALAPPDATA%\voicecast (win)
 * or ${XDG_DATA_HOME:-~/.local/share}/voicecast (linux). Always through here;
 * no module assembles paths directly (voice-dictation pattern).
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
  video: string; // original.fmp4 (raw MediaRecorder output)
  mp4: string; // session.mp4 (faststart remux)
  audio: string; // audio.webm (dictation — no video)
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

/** Ensures the directory tree (called on boot). Idempotent. */
export function ensureLayout(): void {
  for (const dir of [appDataDir(), sessionsRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
