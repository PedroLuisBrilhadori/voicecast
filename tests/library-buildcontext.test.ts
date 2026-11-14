/**
 * buildContext (AN.4) — the "Anotações (N):" section enters the context when
 * the session's `annotations.jsonl` exists (with the burned print's path when
 * the PNG is in frames/) and nothing breaks when it doesn't. Electron mocked
 * (`app.getPath` → tmpdir); the rest is real fs in a temporary directory.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), "voicecast-buildctx-test");
  return {
    app: { getPath: () => join(root, "userData") },
    clipboard: { writeText: () => {} },
  };
});

import { buildContext } from "../src/main/library";

const ROOT = path.join(os.tmpdir(), "voicecast-buildctx-test");
const SESSIONS = path.join(ROOT, "voicecast", "sessions"); // appDataDir = userData/../voicecast
const DAY = "2026-09-27";

/** Creates a minimal session in the library (meta + mp4) and optional extras. */
function makeSession(name: string, extras: { annotations?: string; frames?: string[] } = {}): string {
  const root = path.join(SESSIONS, DAY, name);
  fs.mkdirSync(path.join(root, "frames"), { recursive: true });
  fs.writeFileSync(path.join(root, "session.mp4"), "fake");
  fs.writeFileSync(
    path.join(root, "meta.json"),
    JSON.stringify({
      status: "finalizada",
      startedAt: "2026-09-27T10:00:00.000Z",
      durationS: 300,
      mode: "screen",
      title: "Sessão de teste",
    }),
  );
  if (extras.annotations !== undefined) {
    fs.writeFileSync(path.join(root, "annotations.jsonl"), extras.annotations);
  }
  for (const f of extras.frames ?? []) fs.writeFileSync(path.join(root, "frames", f), "png");
  return root;
}

// jsonl as the engine writes it: stroke, laser, clear + marker's burned print
const JSONL = [
  JSON.stringify({
    t: 100.32, seq: 1, type: "stroke", id: "1", color: "#ff4444", width: 4,
    points: [{ x: 10, y: 10, ms: 0 }, { x: 200, y: 120, ms: 400 }],
  }),
  JSON.stringify({ t: 132.4, seq: 2, type: "laser", points: [{ x: 300, y: 300, ms: 0 }] }),
  JSON.stringify({
    t: 150.9, seq: 3, type: "clear",
    snapshots: [{ id: "1", color: "#ff4444", width: 4, points: [{ x: 10, y: 10, ms: 0 }] }],
  }),
  JSON.stringify({ t: 152.2, seq: 4, type: "print", kind: "marker", file: "frames/marker-1.png", strokes: ["1"] }),
].join("\n") + "\n";

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("buildContext — Annotations section (AN.4)", () => {
  it("includes the section when the jsonl exists, with the burned print's path", async () => {
    const root = makeSession("1010-aaaa1111", { annotations: JSONL, frames: ["marker-1.png"] });
    const r = await buildContext({ dir: DAY, name: "1010-aaaa1111" });
    expect("error" in r).toBe(false);
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("Annotations (4):");
    expect(md).toContain("1. 1:40 brush (erased)");
    expect(md).toContain("2. 2:12 laser");
    expect(md).toContain("3. 2:31 clear");
    expect(md).toContain("4. 2:32 print (marker)");
    expect(md).toContain(`   Print: ${path.join(root, "frames", "marker-1.png")}`);
  });

  it("jsonl without a matching print → section without a Print line", async () => {
    makeSession("1011-bbbb2222", { annotations: JSONL });
    const r = await buildContext({ dir: DAY, name: "1011-bbbb2222" });
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("Annotations (4):");
    expect(md).not.toContain("Print:");
  });

  it("empty jsonl → no section (same behavior as the Segments section)", async () => {
    makeSession("1012-cccc3333", { annotations: "\n" });
    const r = await buildContext({ dir: DAY, name: "1012-cccc3333" });
    const md = (r as { markdown: string }).markdown;
    expect(md).not.toContain("Anotações (");
  });

  it("no jsonl → normal context, nothing breaks", async () => {
    makeSession("1013-dddd4444", { frames: ["session.png"] });
    const r = await buildContext({ dir: DAY, name: "1013-dddd4444" });
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("### voicecast");
    expect(md).not.toContain("Anotações (");
  });
});
