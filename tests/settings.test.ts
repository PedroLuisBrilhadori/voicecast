import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, settingsFile, writeSettings } from "../src/shared/settings";

/**
 * Persistent settings (settings.json in the appDataDir) — pure module: fail-soft
 * reading, merge without key loss and atomic write (tmp+rename).
 */
describe("settings", () => {
  const makeDir = () => mkdtempSync(path.join(tmpdir(), "vc-settings-"));

  it("missing file → {} (default on)", () => {
    const dir = makeDir();
    try {
      expect(readSettings(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write→read roundtrip preserves the key", () => {
    const dir = makeDir();
    try {
      writeSettings(dir, { asrHost: false });
      expect(readSettings(dir).asrHost).toBe(false);
      expect(JSON.parse(readFileSync(settingsFile(dir), "utf-8"))).toEqual({ asrHost: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge: patch doesn't wipe existing keys", () => {
    const dir = makeDir();
    try {
      writeSettings(dir, { asrHost: false });
      writeSettings(dir, {}); // noop
      expect(readSettings(dir)).toEqual({ asrHost: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupted file → {} (fail-soft, never takes down the boot)", () => {
    const dir = makeDir();
    try {
      writeFileSync(settingsFile(dir), "{ quebrado", "utf-8");
      expect(readSettings(dir)).toEqual({});
      // and the next write recovers the file
      writeSettings(dir, { asrHost: true });
      expect(readSettings(dir)).toEqual({ asrHost: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-object JSON (array/null) → {}", () => {
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
