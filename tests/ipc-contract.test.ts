import { describe, expect, it } from "vitest";
import {
  IPC,
  type AnnotationWheelRequest,
  type Bootstrap,
  type CaptureEvent,
  type ClipInfo,
  type CorrectionEdit,
  type CorrectionResult,
  type DatasetItemDetail,
  type DatasetItemSummary,
  type GoalState,
  type PingRequest,
  type PingResponse,
  type SaveCorrectionRequest,
  type SessionMetaPatch,
  type SessionSegment,
  type ValidationBlock,
} from "../src/shared/ipc";

/**
 * O contrato é a superfície entre main/preload/renderer. Se alguém renomear
 * canal ou campo, este teste quebra — o que protege os três lados de derivarem
 * um do outro silenciosamente.
 */
describe("contrato IPC", () => {
  it("canais estáveis", () => {
    expect(IPC.ping).toBe("app:ping");
    expect(IPC.getBootstrap).toBe("app:get-bootstrap");
    expect(IPC.getVersion).toBe("app:get-version");
    expect(IPC.annotationWheel).toBe("annotation:wheel"); // AN.6 scroll-through
    expect(IPC.listClips).toBe("library:list-clips"); // editor fase B
    expect(IPC.exportCut).toBe("library:export-cut"); // editor fase B
  });

  it("payloads serializáveis (sem funções nos tipos de dados)", () => {
    const req: PingRequest = { nonce: 1 };
    const res: PingResponse = { nonce: 1, at: Date.now() };
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  it("AnnotationWheelRequest serializável e completo (AN.6)", () => {
    const wheel: AnnotationWheelRequest = {
      cx: 612,
      cy: 459,
      deltaY: 100,
      deltaMode: 0,
      ctrl: false,
      shift: false,
      buttons: 0,
    };
    expect(JSON.parse(JSON.stringify(wheel))).toEqual(wheel);
    expect(Object.keys(wheel).sort()).toEqual([
      "buttons",
      "ctrl",
      "cx",
      "cy",
      "deltaMode",
      "deltaY",
      "shift",
    ]);
  });

  it("Bootstrap bem formado", () => {
    const b: Bootstrap = {
      version: "0.1.0",
      platform: "win32",
      shortcuts: { recordFullscreen: "Ctrl+Shift+F9", togglePanel: "Ctrl+F9" },
    };
    expect(b.shortcuts.togglePanel).toContain("F9");
  });

  it("payloads do editor fase B serializáveis (segmento, patch de meta, clipe)", () => {
    const seg: SessionSegment = { id: "seg-1", label: "demo", inS: 1.5, outS: 9.25 };
    const patch: SessionMetaPatch = { title: "t", tags: ["a"], segments: [seg] };
    const clip: ClipInfo = { file: "C:\\x\\a.mp4", name: "a.mp4", bytes: 10, mtimeMs: 1 };
    expect(JSON.parse(JSON.stringify(seg))).toEqual(seg);
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
    expect(JSON.parse(JSON.stringify(clip))).toEqual(clip);
  });

  it("canais do cockpit (C4) estáveis", () => {
    expect(IPC.agentRunGoal).toBe("agent:run-goal");
    expect(IPC.agentGetState).toBe("agent:get-state");
  });

  it("evento agent-state e GoalState serializáveis (C4) — payload puro cruza a porta", () => {
    const state: GoalState = {
      id: "g1",
      goal: "abre um PR do C4",
      cwd: "/home/x",
      phase: "running",
      startedAt: 1_700_000_000_000,
      endedAt: null,
      lastOutput: "texto do agente",
      error: null,
    };
    const ev: CaptureEvent = { type: "agent-state", state };
    expect(JSON.parse(JSON.stringify(ev))).toEqual(ev);
    expect(Object.keys(state).sort()).toEqual([
      "cwd",
      "endedAt",
      "error",
      "goal",
      "id",
      "lastOutput",
      "phase",
      "startedAt",
    ]);
  });

  it("canais da correção de ditados + dataset (W2a) estáveis", () => {
    expect(IPC.saveCorrection).toBe("library:save-correction");
    expect(IPC.openCorpus).toBe("library:open-corpus");
    expect(IPC.listDatasetItems).toBe("dataset:list-items");
    expect(IPC.getDatasetItem).toBe("dataset:get-item");
    expect(IPC.saveDatasetCorrection).toBe("dataset:save-correction");
  });

  it("payloads da correção (W2a) serializáveis — schema do corpus cruza a porta", () => {
    const edit: CorrectionEdit = { index: 3, originalW: "notch", correctedW: "note" };
    const req: SaveCorrectionRequest = { correctedText: "texto corrigido", edits: [edit] };
    const validation: ValidationBlock = {
      corrected_text: "texto corrigido",
      ts: "2026-09-29T10:00:00",
      n_edits: 1,
      edits: [edit],
      labeled_by: "voicecast",
    };
    const ok: CorrectionResult = { ok: true, alvo: "ambos", dataset: "ok" };
    const fail: CorrectionResult = { ok: false, error: "dataset ausente" };
    for (const payload of [edit, req, validation, ok, fail]) {
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
    expect(Object.keys(validation).sort()).toEqual([
      "corrected_text",
      "edits",
      "labeled_by",
      "n_edits",
      "ts",
    ]);
    expect(Object.keys(edit).sort()).toEqual(["correctedW", "index", "originalW"]);
  });

  it("itens do dataset (W2a) serializáveis e completos", () => {
    const summary: DatasetItemSummary = {
      id: "011430-6f1d3072",
      ts: "2026-09-19T01:14:52",
      preview: "primeiras palavras…",
      durationS: 2.5,
      source: "dictation",
      language: "pt",
      validated: false,
    };
    const detail: DatasetItemDetail = {
      id: "011430-6f1d3072",
      ts: "2026-09-19T01:14:52",
      text: "texto cru",
      durationS: 2.5,
      source: "dictation",
      language: "pt",
      model: "large-v3-turbo",
      words: [{ w: "texto", start: 0, end: 0.4, p: 0.8 }],
      validation: null,
      audioUrl: "file:///C:/raw/x.wav",
    };
    for (const payload of [summary, detail]) {
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
    expect(Object.keys(summary).sort()).toEqual([
      "durationS",
      "id",
      "language",
      "preview",
      "source",
      "ts",
      "validated",
    ]);
    expect(Object.keys(detail).sort()).toEqual([
      "audioUrl",
      "durationS",
      "id",
      "language",
      "model",
      "source",
      "text",
      "ts",
      "validation",
      "words",
    ]);
  });
});
