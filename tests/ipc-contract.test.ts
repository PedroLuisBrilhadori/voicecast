import { describe, expect, it } from "vitest";
import {
  IPC,
  type AnnotationWheelRequest,
  type Bootstrap,
  type PingRequest,
  type PingResponse,
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
});
