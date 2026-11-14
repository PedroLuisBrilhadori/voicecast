import { describe, expect, it } from "vitest";
import {
  WHEEL_DELTA,
  osWheelDelta,
  packWheelLParam,
  packWheelWParam,
  screenPointFromOverlay,
} from "../src/shared/wheel";

/** Decodes the high-order WORD (signed) of a WM_MOUSEWHEEL wParam. */
const wparamDelta = (w: number): number => w >> 16; // ToInt32 wrapping handles the sign

describe("wheel — scroll-through (AN.6)", () => {
  it("osWheelDelta: 1 DOM notch (100px) → OS delta -120 (scroll down)", () => {
    expect(osWheelDelta({ deltaY: 100, deltaMode: 0 })).toBe(-WHEEL_DELTA);
  });

  it("osWheelDelta: inverted sign (DOM down = OS negative)", () => {
    expect(osWheelDelta({ deltaY: -200, deltaMode: 0 })).toBe(2 * WHEEL_DELTA);
  });

  it("osWheelDelta: line deltaMode (1 line ≈ 40)", () => {
    expect(osWheelDelta({ deltaY: 3, deltaMode: 1 })).toBe(-WHEEL_DELTA);
  });

  it("osWheelDelta: clamps at ±10 notches", () => {
    expect(osWheelDelta({ deltaY: 99999, deltaMode: 0 })).toBe(-10 * WHEEL_DELTA);
    expect(osWheelDelta({ deltaY: -99999, deltaMode: 0 })).toBe(10 * WHEEL_DELTA);
  });

  it("packWheelWParam: delta in the high-order WORD, round-trip with sign", () => {
    const w = packWheelWParam({ delta: -WHEEL_DELTA });
    expect(wparamDelta(w)).toBe(-WHEEL_DELTA);
    expect(w & 0xffff).toBe(0); // no flags
    expect(wparamDelta(packWheelWParam({ delta: 240 }))).toBe(240);
  });

  it("packWheelWParam: MK_CONTROL/MK_SHIFT/buttons in the low-order", () => {
    expect(packWheelWParam({ delta: 0, ctrl: true }) & 0xffff).toBe(0x0008);
    expect(packWheelWParam({ delta: 0, shift: true }) & 0xffff).toBe(0x0004);
    expect(packWheelWParam({ delta: 0, buttons: 1 }) & 0xffff).toBe(0x0001); // left
    expect(packWheelWParam({ delta: 0, buttons: 2 }) & 0xffff).toBe(0x0002); // right
    expect(packWheelWParam({ delta: 0, buttons: 4 }) & 0xffff).toBe(0x0010); // middle
    expect(packWheelWParam({ delta: -120, ctrl: true, buttons: 1 })).toBe(
      ((packWheelWParam({ delta: -120 }) | 0x0008 | 0x0001) >>> 0),
    );
  });

  it("packWheelLParam: MAKELPARAM e coords negativas (multi-display)", () => {
    expect(packWheelLParam(100, 200)).toBe((200 << 16) | 100);
    expect(packWheelLParam(-5, 30) & 0xffff).toBe(0xfffb); // -5 & 0xffff
    expect(packWheelLParam(30, -5) >>> 16).toBe(0xfffb);
  });

  it("screenPointFromOverlay: origin DIPs × scaleFactor + physical offset", () => {
    // display at (10.5, -3) DIPs with sf 1.5 → physical origin (16, -4/−5)
    const p = screenPointFromOverlay({ x: 10.5, y: -3 }, 1.5, 100, 200);
    expect(p.x).toBe(Math.round(10.5 * 1.5) + 100);
    expect(p.y).toBe(Math.round(-3 * 1.5) + 200);
  });

  it("screenPointFromOverlay: sf 1 (no DPI) is identity + offset", () => {
    expect(screenPointFromOverlay({ x: 0, y: 0 }, 1, 400, 300)).toEqual({ x: 400, y: 300 });
  });
});
