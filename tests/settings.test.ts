import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, settingsFile, writeSettings } from "../src/shared/settings";

/**
 * Settings persistente (settings.json no appDataDir) — módulo puro: leitura
 * fail-soft, merge sem perda de chaves e escrita atômica (tmp+rename).
 */
describe("settings", () => {
  const makeDir = () => mkdtempSync(path.join(tmpdir(), "vc-settings-"));

  it("arquivo ausente → {} (default ligado)", () => {
    const dir = makeDir();
    try {
      expect(readSettings(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("roundtrip write→read preserva a chave", () => {
    const dir = makeDir();
    try {
      writeSettings(dir, { asrHost: false });
      expect(readSettings(dir).asrHost).toBe(false);
      expect(JSON.parse(readFileSync(settingsFile(dir), "utf-8"))).toEqual({ asrHost: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge: patch não apaga chaves existentes", () => {
    const dir = makeDir();
    try {
      writeSettings(dir, { asrHost: false });
      writeSettings(dir, {}); // noop
      expect(readSettings(dir)).toEqual({ asrHost: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo corrompido → {} (fail-soft, nunca derruba o boot)", () => {
    const dir = makeDir();
    try {
      writeFileSync(settingsFile(dir), "{ quebrado", "utf-8");
      expect(readSettings(dir)).toEqual({});
      // e a escrita seguinte recupera o arquivo
      writeSettings(dir, { asrHost: true });
      expect(readSettings(dir)).toEqual({ asrHost: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON não-objeto (array/null) → {}", () => {
    const dir = makeDir();
    try {
      writeFileSync(settingsFile(dir), "[1,2]", "utf-8");
      expect(readSettings(dir)).toEqual({});
      writeFileSync(settingsFile(dir), "null", "utf-8");
      expect(readSettings(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
