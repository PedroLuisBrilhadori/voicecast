/**
 * Regressão do bug de encoding da colagem (2026-09-28): o texto do ditado ia
 * por stdin (UTF-8 do Node) para o Python, que decodificava com a codepage da
 * console (cp1252) → "Não" virava "NÃ£o" na janela alvo. O fix é PYTHONUTF8=1
 * + PYTHONIOENCODING=utf-8 no env de TODO spawn python (pythonEnv). Electron
 * mockado (ditado.ts importa electron).
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

describe("pythonEnv (encoding da colagem)", () => {
  it("força UTF-8 nos pipes do Python — sem isso stdin cp1252 mojibaka o ditado", () => {
    const env = pythonEnv({});
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("preserva o resto do env e alinha VOICE_APP_DIR quando o backend existe", () => {
    const base = { PATH: "/x", LOCALAPPDATA: "/definitivamente-inexistente" };
    const env = pythonEnv(base);
    expect(env.PATH).toBe("/x");
    expect(env.VOICE_APP_DIR).toBeUndefined(); // backend ausente nesse LOCALAPPDATA
  });

  it("default = process.env (não zera o ambiente do spawn)", () => {
    const env = pythonEnv();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
