import { describe, expect, it } from "vitest";
import { winPathToWsl, wslPathQuoted, sessionDirName } from "../src/shared/paths";

describe("winPathToWsl", () => {
  it("converts C:\\Users\\pedro\\... to /mnt/c/Users/pedro/...", () => {
    expect(winPathToWsl("C:\\Users\\pedro\\AppData\\Local\\voicecast\\sessions")).toBe(
      "/mnt/c/Users/pedro/AppData/Local/voicecast/sessions",
    );
  });

  it("accepts regular slashes and removes the trailing slash", () => {
    expect(winPathToWsl("D:\\projetos\\x\\")).toBe("/mnt/d/projetos/x");
  });

  it("non-Windows path comes back intact", () => {
    expect(winPathToWsl("/home/pedro/x")).toBe("/home/pedro/x");
  });
});

describe("wslPathQuoted", () => {
  it("quote only when it has a space", () => {
    expect(wslPathQuoted("C:\\sem\\espaco")).toBe("/mnt/c/sem/espaco");
    expect(wslPathQuoted("C:\\Users\\pedro\\Minha Pasta\\a.mp4")).toBe(
      '"/mnt/c/Users/pedro/Minha Pasta/a.mp4"',
    );
  });
});

describe("sessionDirName", () => {
  it("deterministic <hhmm>-<hash8> format", () => {
    const d = new Date(2026, 8, 19, 14, 7); // month 8 = September
    const a = sessionDirName(d, "sessao-x");
    const b = sessionDirName(d, "sessao-x");
    expect(a).toMatch(/^1407-[0-9a-f]{8}$/);
    expect(a).toBe(b);
  });

  it("different seeds → different hashes", () => {
    const d = new Date(2026, 8, 19, 14, 7);
    expect(sessionDirName(d, "a")).not.toBe(sessionDirName(d, "b"));
  });
});
