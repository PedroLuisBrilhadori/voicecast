/**
 * Native scroll-through (AN.6): forwards the mouse wheel to the window
 * UNDER the overlay when it is in drawing mode. The Windows hit-test
 * hands the wheel to the overlay (normal window covering the screen) and Electron has
 * no way to pass it through — setIgnoreMouseEvents({forward:true}) only covers
 * mousemove (and even that isn't reliable on this machine, see REPORT-AN.md).
 *
 * Technique: removes the overlay from the hit-test for an instant (WS_EX_TRANSPARENT in
 * the exstyle — on a layered window it affects hit-test only, not painting), asks
 * WindowFromPoint which window is at the point, restores the exstyle and posts
 * WM_MOUSEWHEEL to it. All synchronous, in the same call — no flicker.
 *
 * Windows-only + lazy koffi: outside Windows (or without a loadable koffi) it's a
 * fail-soft no-op (elevated windows via UIPI also silently ignore
 * PostMessage — acceptable, nothing breaks).
 */
import type { BrowserWindow } from "electron";
import { logError, logInfo } from "./logging";

const GWL_EXSTYLE = -20;
const WM_MOUSEWHEEL = 0x020a;

interface User32 {
  windowFromPoint(pt: { x: number; y: number }): bigint;
  getWindowLong(hwnd: bigint, index: number): number;
  setWindowPos(hwnd: bigint, x: number, y: number, flags: number): boolean;
  postMessage(hwnd: bigint, msg: number, wparam: number, lparam: number): boolean;
  setCursorPos(x: number, y: number): boolean;
  getAncestor(hwnd: bigint, flags: number): bigint;
}

/** Minimal koffi surface (without importing the package types — ESM-only). */
/* eslint-disable @typescript-eslint/no-explicit-any */
let user32: User32 | null | undefined; // undefined = not attempted; null = failed
let lastLogAt = 0; // log throttle (the wheel fires event bursts)
let outTimer: NodeJS.Timeout | null = null; // overlay off-screen during the burst

const GA_ROOT = 2;

function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (process.platform !== "win32") return user32;
  try {
    // require (not import): only exists/loadable on the Windows host
    const koffi = require("koffi") as {
      load(name: string): { func(sig: string): any };
      struct(name: string, fields: Record<string, string>): unknown;
    };
    const dll = koffi.load("user32.dll");
    koffi.struct("VcPoint", { x: "long", y: "long" });
    user32 = {
      windowFromPoint: dll.func("intptr __stdcall WindowFromPoint(VcPoint pt)"),
      getWindowLong: dll.func("long __stdcall GetWindowLongW(intptr hwnd, int index)"),
      setWindowPos: dll.func("bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint flags)"),
      postMessage: dll.func("bool __stdcall PostMessageW(intptr hwnd, uint msg, uintptr wparam, uintptr lparam)"),
      setCursorPos: dll.func("bool __stdcall SetCursorPos(int x, int y)"),
      getAncestor: dll.func("intptr __stdcall GetAncestor(intptr hwnd, uint flags)"),
    };
  } catch (e) {
    logError("native-wheel: koffi/user32 unavailable — scroll-through off:", e);
  }
  return user32;
}

/** Overlay HWND (Electron little-endian buffer) — null outside win32. */
export function hwndFromWindow(w: BrowserWindow): bigint | null {
  if (process.platform !== "win32") return null;
  try {
    return w.getNativeWindowHandle().readBigUInt64LE(0);
  } catch (e) {
    logError("native-wheel: getNativeWindowHandle failed:", e);
    return null;
  }
}

/** Moves the physical cursor (screen px) — the smoke test uses it to simulate real hover. */
export function setCursorPos(x: number, y: number): boolean {
  const u32 = loadUser32();
  if (!u32) return false;
  try {
    return u32.setCursorPos(x, y);
  } catch (e) {
    logError("native-wheel: setCursorPos failed:", e);
    return false;
  }
}

/** Window exstyle (diagnostics: LAYERED/TRANSPARENT per mode). */
export function windowExStyle(w: BrowserWindow): number | null {
  const u32 = loadUser32();
  if (!u32) return null;
  const hwnd = hwndFromWindow(w);
  if (hwnd === null) return null;
  try {
    return u32.getWindowLong(hwnd, GWL_EXSTYLE) >>> 0;
  } catch {
    return null;
  }
}

/**
 * Posts WM_MOUSEWHEEL to the window under the point (x, y in physical screen
 * px). Returns false if no target was found or it failed (caller logs debug).
 */
export function forwardWheelNative(
  hwndSelf: bigint,
  x: number,
  y: number,
  origX: number,
  origY: number,
  wparam: number,
  lparam: number,
): boolean {
  const u32 = loadUser32();
  if (!u32) return false;
  try {
    // Pushes the overlay off-screen for an instant and asks
    // WindowFromPoint who is at the point, bringing it back right after —
    // all synchronous, without touching focus/z-order/style. (WS_EX_TRANSPARENT doesn't
    // work here: the Electron window is WS_EX_NOREDIRECTIONBITMAP, not
    // layered — hit-test skip via style requires WS_EX_LAYERED; validated in the
    // 2026-09-22 wheeltest: with the style toggle, WindowFromPoint kept
    // returning the overlay's own child.)
    const SWP = 0x15; // NOSIZE | NOZORDER | NOACTIVATE
    const OFF = -32000;
    // Moves the overlay off-screen ONCE PER WHEEL BURST (not per event):
    // each fullscreen SetWindowPos forces a DWM recomposition — per event, the
    // mouse stutters. Comes back 150ms after the last wheel (clicks in that window
    // go to the app below — acceptable: whoever is scrolling isn't clicking).
    if (!outTimer) u32.setWindowPos(hwndSelf, OFF, OFF, SWP);
    else clearTimeout(outTimer);
    outTimer = setTimeout(() => {
      outTimer = null;
      try {
        u32.setWindowPos(hwndSelf, origX, origY, SWP);
      } catch {}
    }, 150);
    outTimer.unref?.();
    let target = 0n;
    try {
      target = u32.windowFromPoint({ x, y });
    } catch {
      // WindowFromPoint rarely fails; never leave the overlay off-screen
    }
    // anti-loop safety: the target may be a CHILD HWND of the overlay itself
    // (Chrome_RenderWidgetHostHWND) — compare by root
    const root = target === 0n ? 0n : u32.getAncestor(target, GA_ROOT);
    const selfRoot = u32.getAncestor(hwndSelf, GA_ROOT);
    if (target === 0n || target === hwndSelf || root === selfRoot) {
      const now = Date.now();
      if (now - lastLogAt > 1000) {
        lastLogAt = now;
        logInfo(`native-wheel: no target at (${x},${y}) target=${target} selfRoot=${selfRoot}`);
      }
      return false;
    }
    const ok = u32.postMessage(target, WM_MOUSEWHEEL, wparam, lparam);
    const now = Date.now();
    if (!ok || now - lastLogAt > 1000) {
      lastLogAt = now;
      logInfo(`native-wheel: wheel (${x},${y}) delta=${wparam >> 16} → target=${target} root=${root} post=${ok}`);
    }
    return ok;
  } catch (e) {
    logError("native-wheel: forwardWheel failed:", e);
    return false;
  }
}
