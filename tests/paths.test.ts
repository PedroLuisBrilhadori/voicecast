import { describe, expect, it } from "vitest";
import { winPathToWsl, wslPathQuoted, sessionDirName } from "../src/shared/paths";

describe("winPathToWsl", () => {
  it("converte C:\\Users\\pedro\\... para /mnt/c/Users/pedro/...", () => {
    expect(winPathToWsl("C:\\Users\\pedro\\AppData\\Local\\voicecast\\sessions")).toBe(
      "/mnt/c/Users/pedro/AppData/Local/voicecast/sessions",
    );
  });

  it("aceita barras normais e remove trailing slash", () => {
    expect(winPathToWsl("D:\\projetos\\x\\")).toBe("/mnt/d/projetos/x");
  });

  it("path não-Windows volta intacto", () => {
    expect(winPathToWsl("/home/pedro/x")).toBe("/home/pedro/x");
  });
});

describe("wslPathQuoted", () => {
  it("citar apenas quando tem espaço", () => {
    expect(wslPathQuoted("C:\\sem\\espaco")).toBe("/mnt/c/sem/espaco");
    expect(wslPathQuoted("C:\\Users\\pedro\\Minha Pasta\\a.mp4")).toBe(
      '"/mnt/c/Users/pedro/Minha Pasta/a.mp4"',
    );
  });
});

describe("sessionDirName", () => {
  it("formato <hhmm>-<hash8> determinístico", () => {
    const d = new Date(2026, 8, 19, 14, 7); // mês 8 = setembro
    const a = sessionDirName(d, "sessao-x");
    const b = sessionDirName(d, "sessao-x");
    expect(a).toMatch(/^1407-[0-9a-f]{8}$/);
    expect(a).toBe(b);
  });

  it("sementes diferentes → hashes diferentes", () => {
    const d = new Date(2026, 8, 19, 14, 7);
    expect(sessionDirName(d, "a")).not.toBe(sessionDirName(d, "b"));
  });
});
