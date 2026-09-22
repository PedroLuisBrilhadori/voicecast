/**
 * Motor puro do scroll-through (AN.6): converte um WheelEvent DOM nos campos
 * do WM_MOUSEWHEEL do Windows. Sem Electron — testável em vitest.
 *
 * Sinais: DOM deltaY > 0 = rolar para baixo; WM_MOUSEWHEEL delta < 0 = para
 * baixo. O high-order WORD do wParam carrega o delta (com sinal), o low-order
 * os MK_* flags; o lParam é MAKELPARAM(x, y) em px FÍSICOS de tela.
 */

/** WHEEL_DELTA do Windows: 1 "notch" da roda. */
export const WHEEL_DELTA = 120;

/** Teto do delta por evento (10 notches) — protege contra rajadas absurdas. */
const DELTA_LIMIT = WHEEL_DELTA * 10;

/**
 * DOM WheelEvent no Chromium/Windows: 1 notch (delta OS 120) vira deltaY=100
 * com deltaMode=DOM_DELTA_PIXEL (0) — o fator 1.2 reconstrói o delta original.
 * deltaMode=DOM_DELTA_LINE (1): 1 linha ≈ 40 (notch ÷ 3 linhas padrão).
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

/** wParam do WM_MOUSEWHEEL: delta no high-order WORD, MK_* no low-order. */
export function packWheelWParam(p: {
  delta: number;
  ctrl?: boolean;
  shift?: boolean;
  /** bitmask DOM (1 esq, 2 dir, 4 meio) — botões pressionados junto da roda. */
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

/** lParam: MAKELPARAM(x, y) — máscara cobre coords negativas (multi-display). */
export function packWheelLParam(x: number, y: number): number {
  return (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
}

/**
 * Ponto de tela em px FÍSICOS a partir do evento (cx/cy físicos dentro do
 * overlay) + origem do overlay em DIPs + scaleFactor do display. O Win32
 * (WindowFromPoint/PostMessage) fala em pixels, o Electron em DIPs.
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
