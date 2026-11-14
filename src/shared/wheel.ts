/**
 * Pure scroll-through engine (AN.6): converts a DOM WheelEvent into the
 * Windows WM_MOUSEWHEEL fields. No Electron — testable in vitest.
 *
 * Signs: DOM deltaY > 0 = scroll down; WM_MOUSEWHEEL delta < 0 = down. The
 * high-order WORD of wParam carries the delta (signed), the low-order the
 * MK_* flags; lParam is MAKELPARAM(x, y) in PHYSICAL screen px.
 */

/** Windows WHEEL_DELTA: 1 wheel "notch". */
export const WHEEL_DELTA = 120;

/** Per-event delta cap (10 notches) — protects against absurd bursts. */
const DELTA_LIMIT = WHEEL_DELTA * 10;

/**
 * DOM WheelEvent on Chromium/Windows: 1 notch (OS delta 120) becomes
 * deltaY=100 with deltaMode=DOM_DELTA_PIXEL (0) — the 1.2 factor rebuilds
 * the original delta. deltaMode=DOM_DELTA_LINE (1): 1 line ≈ 40
 * (notch ÷ 3 default lines).
 */
export function osWheelDelta(e: { deltaY: number; deltaMode?: number }): number {
  const raw = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY * 1.2;
  const delta = -Math.round(raw);
  return Math.max(-DELTA_LIMIT, Math.min(DELTA_LIMIT, delta));
}

const MK_LBUTTON = 0x0001;
const MK_RBUTTON = 0x0002;
const MK_SHIFT = 0x0004;
const MK_CONTROL = 0x0008;
const MK_MBUTTON = 0x0010;

/** WM_MOUSEWHEEL wParam: delta in the high-order WORD, MK_* in the low-order. */
export function packWheelWParam(p: {
  delta: number;
  ctrl?: boolean;
  shift?: boolean;
  /** DOM bitmask (1 left, 2 right, 4 middle) — buttons held while wheeling. */
  buttons?: number;
}): number {
  let mk = 0;
  if (p.ctrl) mk |= MK_CONTROL;
  if (p.shift) mk |= MK_SHIFT;
  const b = p.buttons ?? 0;
  if (b & 1) mk |= MK_LBUTTON;
  if (b & 2) mk |= MK_RBUTTON;
  if (b & 4) mk |= MK_MBUTTON;
  return (((p.delta & 0xffff) << 16) | mk) >>> 0;
}

/** lParam: MAKELPARAM(x, y) — mask covers negative coords (multi-display). */
export function packWheelLParam(x: number, y: number): number {
  return (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
}

/**
 * Screen point in PHYSICAL px from the event (physical cx/cy inside the
 * overlay) + overlay origin in DIPs + display scaleFactor. Win32
 * (WindowFromPoint/PostMessage) speaks in pixels, Electron in DIPs.
 */
export function screenPointFromOverlay(
  bounds: { x: number; y: number },
  scaleFactor: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  return {
    x: Math.round(bounds.x * scaleFactor) + cx,
    y: Math.round(bounds.y * scaleFactor) + cy,
  };
}
