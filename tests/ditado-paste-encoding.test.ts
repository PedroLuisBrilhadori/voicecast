/**
 * Regression of the paste encoding bug (2026-09-28): dictation text went
 * through stdin (Node's UTF-8) to Python, which decoded it with the console
 * codepage (cp1252) → "Não" became "NÃ£o" in the target window. The fix is
 * PYTHONUTF8=1 + PYTHONIOENCODING=utf-8 in the env of EVERY python spawn
 * (pythonEnv). Electron mocked (ditado.ts imports electron).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => ({
  app: { getPath: () => "/tmp/voicecast-ditado-test" },
  clipboard: { writeText: () => {} },
  globalShortcut: { register: () => true, unregister: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
}));

import { pythonEnv } from "../src/main/ditado";

describe("pythonEnv (paste encoding)", () => {
  it("forces UTF-8 on Python's pipes — without it cp1252 stdin mojibakes the dictation", () => {
    const env = pythonEnv({});
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("preserves the rest of the env and aligns VOICE_APP_DIR when the backend exists", () => {
    const base = { PATH: "/x", LOCALAPPDATA: "/definitivamente-inexistente" };
    const env = pythonEnv(base);
    expect(env.PATH).toBe("/x");
    expect(env.VOICE_APP_DIR).toBeUndefined(); // backend missing at that LOCALAPPDATA
  });

  it("default = process.env (doesn't zero out the spawn environment)", () => {
    const env = pythonEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
