/**
 * buildContext (AN.4) — a seção "Anotações (N):" entra no contexto quando o
 * `annotations.jsonl` da sessão existe (com path do print queimado quando o
 * PNG está em frames/) e nada quebra quando não existe. Electron mockado
 * (`app.getPath` → tmpdir); o resto é fs real em diretório temporário.
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

/** Cria uma sessão mínima na biblioteca (meta + mp4) e extras opcionais. */
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

// jsonl como o engine grava: stroke, laser, clear + print queimado do marker
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

describe("buildContext — seção Anotações (AN.4)", () => {
  it("inclui a seção quando o jsonl existe, com path do print queimado", async () => {
    const root = makeSession("1010-aaaa1111", { annotations: JSONL, frames: ["marker-1.png"] });
    const r = await buildContext({ dir: DAY, name: "1010-aaaa1111" });
    expect("error" in r).toBe(false);
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("Anotações (4):");
    expect(md).toContain("1. 1:40 pincel (apagado)");
    expect(md).toContain("2. 2:12 laser");
    expect(md).toContain("3. 2:31 limpar");
    expect(md).toContain("4. 2:32 print (marker)");
    expect(md).toContain(`   Print: ${path.join(root, "frames", "marker-1.png")}`);
  });

  it("jsonl sem print correspondente → seção sem linha de Print", async () => {
    makeSession("1011-bbbb2222", { annotations: JSONL });
    const r = await buildContext({ dir: DAY, name: "1011-bbbb2222" });
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("Anotações (4):");
    expect(md).not.toContain("Print:");
  });

  it("jsonl vazio → sem seção (mesmo comportamento da seção Trechos)", async () => {
    makeSession("1012-cccc3333", { annotations: "\n" });
    const r = await buildContext({ dir: DAY, name: "1012-cccc3333" });
    const md = (r as { markdown: string }).markdown;
    expect(md).not.toContain("Anotações (");
  });

  it("sem jsonl → contexto normal, nada quebra", async () => {
    makeSession("1013-dddd4444", { frames: ["session.png"] });
    const r = await buildContext({ dir: DAY, name: "1013-dddd4444" });
    const md = (r as { markdown: string }).markdown;
    expect(md).toContain("### voicecast");
    expect(md).not.toContain("Anotações (");
  });
});
