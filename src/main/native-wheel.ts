/**
 * Scroll-through nativo (AN.6): encaminha a roda do mouse para a janela DE
 * BAIXO do overlay quando ele está em modo desenho. O hit-test do Windows
 * entrega a roda ao overlay (janela normal cobrindo a tela) e o Electron não
 * tem como repassá-la — setIgnoreMouseEvents({forward:true}) só cobre
 * mousemove (e nem isso é confiável nesta máquina, ver RELATORIO-AN.md).
 *
 * Técnica: tira o overlay do hit-test por um instante (WS_EX_TRANSPARENT no
 * exstyle — em janela layered afeta só hit-test, não pintura), pergunta
 * WindowFromPoint qual janela está no ponto, restaura o exstyle e posta
 * WM_MOUSEWHEEL nela. Tudo síncrono, na mesma chamada — sem flicker.
 *
 * Windows-only + koffi lazy: fora do Windows (ou sem koffi carregável) é
 * no-op fail-soft (janelas elevadas via UIPI também silenciosamente ignoram
 * o PostMessage — aceitável, nada quebra).
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

/** Superfície mínima do koffi (sem importar os tipos do pacote — ESM-only). */
/* eslint-disable @typescript-eslint/no-explicit-any */
let user32: User32 | null | undefined; // undefined = não tentado; null = falhou
let lastLogAt = 0; // throttle do log (a roda dispara rajadas de eventos)

const GA_ROOT = 2;

function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (process.platform !== "win32") return user32;
  try {
    // require (não import): só existe/é carregável no Windows host
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
    logError("native-wheel: koffi/user32 indisponível — scroll-through off:", e);
  }
  return user32;
}

/** HWND do overlay (buffer little-endian do Electron) — null fora do win32. */
export function hwndFromWindow(w: BrowserWindow): bigint | null {
  if (process.platform !== "win32") return null;
  try {
    return w.getNativeWindowHandle().readBigUInt64LE(0);
  } catch (e) {
    logError("native-wheel: getNativeWindowHandle falhou:", e);
    return null;
  }
}

/** Move o cursor físico (px de tela) — smoke usa p/ simular hover real. */
export function setCursorPos(x: number, y: number): boolean {
  const u32 = loadUser32();
  if (!u32) return false;
  try {
    return u32.setCursorPos(x, y);
  } catch (e) {
    logError("native-wheel: setCursorPos falhou:", e);
    return false;
  }
}

/** Exstyle da janela (diagnóstico: LAYERED/TRANSPARENT por modo). */
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
 * Posta WM_MOUSEWHEEL na janela de baixo do ponto (x, y em px físicos de
 * tela). Retorna false se não achou alvo ou falhou (caller loga debug).
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
    // Empurra o overlay para fora da tela por um instante e pergunta
    // WindowFromPoint quem está no ponto, trazendo-o de volta em seguida —
    // tudo síncrono, sem tocar em foco/z-order/estilo. (WS_EX_TRANSPARENT não
    // funciona aqui: a janela do Electron é WS_EX_NOREDIRECTIONBITMAP, não
    // layered — o skip de hit-test por estilo exige WS_EX_LAYERED; validado no
    // wheeltest de 2026-09-22: com o toggle de estilo, WindowFromPoint seguia
    // devolvendo o filho do próprio overlay.)
    const SWP = 0x15; // NOSIZE | NOZORDER | NOACTIVATE
    const OFF = -32000;
    u32.setWindowPos(hwndSelf, OFF, OFF, SWP);
    let target = 0n;
    try {
      target = u32.windowFromPoint({ x, y });
    } finally {
      u32.setWindowPos(hwndSelf, origX, origY, SWP);
    }
    // segurança anti-loop: pode vir um HWND FILHO do próprio overlay
    // (Chrome_RenderWidgetHostHWND) — compara pela raiz
    const root = target === 0n ? 0n : u32.getAncestor(target, GA_ROOT);
    const selfRoot = u32.getAncestor(hwndSelf, GA_ROOT);
    if (target === 0n || target === hwndSelf || root === selfRoot) {
      const now = Date.now();
      if (now - lastLogAt > 1000) {
        lastLogAt = now;
        logInfo(`native-wheel: sem alvo em (${x},${y}) target=${target} selfRoot=${selfRoot}`);
      }
      return false;
    }
    const ok = u32.postMessage(target, WM_MOUSEWHEEL, wparam, lparam);
    const now = Date.now();
    if (!ok || now - lastLogAt > 1000) {
      lastLogAt = now;
      logInfo(`native-wheel: roda (${x},${y}) delta=${wparam >> 16} → alvo=${target} root=${root} post=${ok}`);
    }
    return ok;
  } catch (e) {
    logError("native-wheel: forwardWheel falhou:", e);
    return false;
  }
}
