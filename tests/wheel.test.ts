import { describe, expect, it } from "vitest";
import {
  WHEEL_DELTA,
  osWheelDelta,
  packWheelLParam,
  packWheelWParam,
  screenPointFromOverlay,
} from "../src/shared/wheel";

/** Decodifica o high-order WORD (com sinal) de um wParam de WM_MOUSEWHEEL. */
const wparamDelta = (w: number): number => w >> 16; // ToInt32 wrapping faz o sinal

describe("wheel — scroll-through (AN.6)", () => {
  it("osWheelDelta: 1 notch DOM (100px) → delta OS -120 (rolar p/ baixo)", () => {
    expect(osWheelDelta({ deltaY: 100, deltaMode: 0 })).toBe(-WHEEL_DELTA);
  });

  it("osWheelDelta: sinal invertido (DOM p/ baixo = OS negativo)", () => {
    expect(osWheelDelta({ deltaY: -200, deltaMode: 0 })).toBe(2 * WHEEL_DELTA);
  });

  it("osWheelDelta: deltaMode linha (1 linha ≈ 40)", () => {
    expect(osWheelDelta({ deltaY: 3, deltaMode: 1 })).toBe(-WHEEL_DELTA);
  });

  it("osWheelDelta: clampa em ±10 notches", () => {
    expect(osWheelDelta({ deltaY: 99999, deltaMode: 0 })).toBe(-10 * WHEEL_DELTA);
    expect(osWheelDelta({ deltaY: -99999, deltaMode: 0 })).toBe(10 * WHEEL_DELTA);
  });

  it("packWheelWParam: delta no high-order WORD, ida e volta com sinal", () => {
    const w = packWheelWParam({ delta: -WHEEL_DELTA });
    expect(wparamDelta(w)).toBe(-WHEEL_DELTA);
    expect(w & 0xffff).toBe(0); // sem flags
    expect(wparamDelta(packWheelWParam({ delta: 240 }))).toBe(240);
  });

  it("packWheelWParam: MK_CONTROL/MK_SHIFT/botões no low-order", () => {
    expect(packWheelWParam({ delta: 0, ctrl: true }) & 0xffff).toBe(0x0008);
    expect(packWheelWParam({ delta: 0, shift: true }) & 0xffff).toBe(0x0004);
    expect(packWheelWParam({ delta: 0, buttons: 1 }) & 0xffff).toBe(0x0001); // esq
    expect(packWheelWParam({ delta: 0, buttons: 2 }) & 0xffff).toBe(0x0002); // dir
    expect(packWheelWParam({ delta: 0, buttons: 4 }) & 0xffff).toBe(0x0010); // meio
    expect(packWheelWParam({ delta: -120, ctrl: true, buttons: 1 })).toBe(
      ((packWheelWParam({ delta: -120 }) | 0x0008 | 0x0001) >>> 0),
    );
  });

  it("packWheelLParam: MAKELPARAM e coords negativas (multi-display)", () => {
    expect(packWheelLParam(100, 200)).toBe((200 << 16) | 100);
    expect(packWheelLParam(-5, 30) & 0xffff).toBe(0xfffb); // -5 & 0xffff
    expect(packWheelLParam(30, -5) >>> 16).toBe(0xfffb);
  });

  it("screenPointFromOverlay: DIPs de origem × scaleFactor + offset físico", () => {
    // display em (10.5, -3) DIPs com sf 1.5 → origem física (16, -4/−5)
    const p = screenPointFromOverlay({ x: 10.5, y: -3 }, 1.5, 100, 200);
    expect(p.x).toBe(Math.round(10.5 * 1.5) + 100);
    expect(p.y).toBe(Math.round(-3 * 1.5) + 200);
  });

  it("screenPointFromOverlay: sf 1 (sem DPI) é identidade + offset", () => {
    expect(screenPointFromOverlay({ x: 0, y: 0 }, 1, 400, 300)).toEqual({ x: 400, y: 300 });
  });
});
