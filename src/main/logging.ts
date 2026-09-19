/**
 * Log do processo main em arquivo (appDataDir/logs/main.log) + stderr.
 * Instrumentação mínima para debugar o app rodando no Windows sem console.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

let stream: fs.WriteStream | null = null;

function logFile(): string {
  const dir = path.join(app.getPath("userData"), "..", "voicecast", "logs");
  fs.mkdirSync(dir, { recursive: true });
  // rotate simples: mantém main.log e main.log.1
  const file = path.join(dir, "main.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) {
      fs.renameSync(file, file + ".1");
    }
  } catch {}
  return file;
}

export function initLogging(): void {
  try {
    stream = fs.createWriteStream(logFile(), { flags: "a" });
  } catch {
    stream = null;
  }

  const write = (level: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")}\n`;
    try {
      stream?.write(line);
    } catch {}
    process.stderr.write(line);
  };

  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => {
    orig.log(...a);
    write("info", a);
  };
  console.warn = (...a: unknown[]) => {
    orig.warn(...a);
    write("warn", a);
  };
  console.error = (...a: unknown[]) => {
    orig.error(...a);
    write("error", a);
  };

  process.on("uncaughtException", (e) => {
    console.error("uncaughtException:", e.stack ?? String(e));
  });
  process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection:", String(e));
  });
}

export function logInfo(...args: unknown[]): void {
  console.log(...args);
}
export function logError(...args: unknown[]): void {
  console.error(...args);
}
