"""Windows backend — Win32 (ctypes) code of the voice dictation.

Moved VERBATIM from dictation_daemon.py (2026-08): SendInput (INPUT struct
with union — cbSize 40 on x64), CF_UNICODETEXT clipboard, focus_window without
the "ALT trick", WM_PASTE, UIA as diagnostics, GetAsyncKeyState for the hotkey,
kernel32.Beep and the panel overlay via PowerShell + msedge --app.

Any regression on Windows: compare against the history of the
dictation_daemon.py file before the platform/ refactor.
"""

from __future__ import annotations

import base64
import ctypes
import logging
import os
import subprocess
import time

from voice.platform.common import app_dir, host_src, venv_python

log = logging.getLogger("voice-dictate")

APP_DIR = app_dir()

VENV_PYTHONW = os.path.join(app_dir(), ".venv", "Scripts", "pythonw.exe")
VENV_PYTHON = venv_python()
HOST_SRC = host_src()

# ── Win32 (ctypes) ────────────────────────────────────────────────
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

VK_CONTROL = 0x11
VK_V = 0x56
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008
INPUT_KEYBOARD = 1
CF_UNICODETEXT = 13
WM_PASTE = 0x0302
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_void_p),  # ULONG_PTR
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_void_p),  # ULONG_PTR
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    """Win32 INPUT struct (x64 = 40 bytes). Without the union, cbSize becomes 32
    (wrong) and SendInput fails with ERROR_INVALID_PARAMETER (returns 0)."""
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTUNION)]


def _input(vk: int, scan: int, flags: int) -> INPUT:
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ki.wVk = vk
    inp.ki.wScan = scan
    inp.ki.dwFlags = flags
    return inp


def _send_input(events: list[INPUT]) -> int:
    """Sends keyboard events via SendInput. Returns how many were accepted."""
    n = len(events)
    if n == 0:
        return 0
    arr = (INPUT * n)(*events)
    return user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(INPUT))


def key_down(vk: int) -> None:
    _send_input([_input(vk, 0, 0)])


def key_up(vk: int) -> None:
    _send_input([_input(vk, 0, KEYEVENTF_KEYUP)])


def type_unicode(text: str) -> None:
    """Types text character by character via KEYEVENTF_UNICODE (real keyboard)."""
    events: list[INPUT] = []
    for ch in text:
        scan = ord(ch)
        events.append(_input(0, scan, KEYEVENTF_UNICODE))
        events.append(_input(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    _send_input(events)


def scan_code(vk: int) -> int:
    return user32.MapVirtualKeyW(vk, 0)


def send_ctrl_v() -> int:
    """Ctrl+V with scan codes. Returns how many events Windows accepted (4 = ok)."""
    sc_ctrl = scan_code(VK_CONTROL)
    sc_v = scan_code(VK_V)
    events = [
        _input(VK_CONTROL, sc_ctrl, KEYEVENTF_SCANCODE),
        _input(VK_V, sc_v, KEYEVENTF_SCANCODE),
        _input(VK_V, sc_v, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
        _input(VK_CONTROL, sc_ctrl, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
    ]
    return _send_input(events)


def f9_pressed() -> bool:
    return bool(user32.GetAsyncKeyState(F9_VK) & 0x8000)


F9_VK = 0x78
VK_SHIFT = 0x10


def shift_pressed() -> bool:
    """GLOBAL Shift state (independent of the focused window) — Shift+F9 opens
    the panel without recording. Same polling window as F9 (~12ms)."""
    return bool(user32.GetAsyncKeyState(VK_SHIFT) & 0x8000)


def ctrl_pressed() -> bool:
    """GLOBAL Ctrl state — Ctrl combos belong to voicecast (v2)."""
    return bool(user32.GetAsyncKeyState(VK_CONTROL) & 0x8000)


def beep(freq: int, ms: int) -> None:
    kernel32.Beep(freq, ms)


# ── Focus / target window ─────────────────────────────────────────
def foreground_hwnd() -> int:
    return int(user32.GetForegroundWindow())


def window_info(hwnd: int) -> str:
    """'title (pid)' of the window — for diagnostics."""
    try:
        length = user32.GetWindowTextLengthW(hwnd) + 1
        buf = ctypes.create_unicode_buffer(length)
        user32.GetWindowTextW(hwnd, buf, length)
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return f"{buf.value!r} (pid {pid.value})"
    except Exception:
        return f"hwnd={hwnd}"


def focus_window(hwnd: int) -> bool:
    """Makes sure hwnd is the foreground window.

    If it's already foreground, does nothing (avoids ALT/menus). Otherwise uses
    AttachThreadInput + BringWindowToTop + SetForegroundWindow — without the
    "ALT trick", which activates the menu bar in apps like Notepad and hijacks input.
    """
    if not hwnd:
        return False
    try:
        if user32.GetForegroundWindow() == hwnd:
            return True
        target_tid = user32.GetWindowThreadProcessId(hwnd, None)
        cur_tid = kernel32.GetCurrentThreadId()
        attached = False
        if target_tid and target_tid != cur_tid:
            attached = user32.AttachThreadInput(cur_tid, target_tid, True)
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(cur_tid, target_tid, False)
        return user32.GetForegroundWindow() == hwnd
    except Exception:
        log.exception("focus_window failed")
        return False


def pid_alive(pid: int) -> bool:
    """True if the Windows process with this PID still exists (via OpenProcess)."""
    if pid <= 0:
        return False
    try:
        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x102
        h = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not h:
            return False
        try:
            return kernel32.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        return False


# ── Clipboard / pasting ───────────────────────────────────────────
# Win32 types for pointers (GlobalAlloc/GlobalLock return 64-bit HGLOBAL;
# without restype/argtypes ctypes truncates to c_int and corrupts the handle)
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
user32.SetClipboardData.restype = ctypes.c_void_p


def set_clipboard(text: str) -> bool:
    """Puts text on the clipboard via the Win32 API (CF_UNICODETEXT), no clip.exe."""
    try:
        if not user32.OpenClipboard(None):
            log.warning("OpenClipboard failed")
            return False
        try:
            user32.EmptyClipboard()
            data = text.encode("utf-16-le") + b"\x00\x00"
            hmem = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(data))
            if not hmem:
                return False
            ptr = kernel32.GlobalLock(hmem)
            if not ptr:
                kernel32.GlobalFree(hmem)
                return False
            ctypes.memmove(ctypes.c_void_p(ptr), data, len(data))
            kernel32.GlobalUnlock(hmem)
            if not user32.SetClipboardData(CF_UNICODETEXT, hmem):
                kernel32.GlobalFree(hmem)
                return False
            return True
        finally:
            user32.CloseClipboard()
    except Exception:
        log.exception("set_clipboard failed")
        return False


def _paste_clipboard(text: str) -> str:
    """Win32 clipboard + Ctrl+V with scan codes. Returns 'ok' or 'fail'."""
    if not set_clipboard(text):
        return "clipboard-set-falhou"
    n = send_ctrl_v()
    if n >= 4:
        return "clipboard"
    log.warning("Ctrl+V delivered %d/4 events", n)
    return "ctrl-v-bloqueado"


def _paste_unicode(text: str) -> str:
    type_unicode(text)
    return "unicode"


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("flags", ctypes.c_uint),
        ("hwndActive", ctypes.c_void_p),
        ("hwndFocus", ctypes.c_void_p),
        ("hwndCapture", ctypes.c_void_p),
        ("hwndMenuOwner", ctypes.c_void_p),
        ("hwndMoveSize", ctypes.c_void_p),
        ("hwndCaret", ctypes.c_void_p),
        ("rcCaret", ctypes.c_void_p),
    ]


def _paste_wm(text: str, hwnd: int) -> str:
    """Last resort: WM_PASTE straight to the focused control of the target window
    (apps that ignore synthesized keyboard input). Requires window focus."""
    if not set_clipboard(text):
        return "wm-clipboard-falhou"
    try:
        focus_window(hwnd)
        info = GUITHREADINFO()
        info.cbSize = ctypes.sizeof(GUITHREADINFO)
        tid = user32.GetWindowThreadProcessId(hwnd, None)
        if not user32.GetGUIThreadInfo(tid, ctypes.byref(info)):
            log.warning("GetGUIThreadInfo failed - WM_PASTE on the root window")
            user32.SendMessageW(hwnd, WM_PASTE, 0, 0)
            return "wm_paste"
        child = int(info.hwndFocus) or hwnd
        res = user32.SendMessageW(child, WM_PASTE, 0, 0)
        return "wm_paste" if res else "wm-paste-falhou"
    except Exception:
        log.exception("WM_PASTE failed")
        return "wm-paste-falhou"


def _focused_text() -> str:
    """Text of the focused control via UIAutomation. Empty if unavailable."""
    try:
        import uiautomation as auto

        ctrl = auto.GetForegroundControl()
        if ctrl is None:
            return ""
        for pattern in ("ValueControl", "EditControl", "DocumentControl"):
            try:
                if getattr(ctrl, pattern):
                    v = ctrl.GetValuePattern()
                    if v:
                        return v.Value or ""
            except Exception:
                continue
        return ctrl.Name or ""
    except Exception:
        return ""


def paste_into_focused(text: str, mode: str, target_hwnd: int) -> str:
    """Inserts the text into the target window. Returns the mode actually used.

    A single insertion per dictation: if Ctrl+V was delivered (4/4) we assume
    success. We do NOT re-type via unicode based on UIA heuristics — Electron
    apps (Discord) don't expose their content and the check caused duplication.
    """
    log.info("insertion target: %s", window_info(target_hwnd))

    if mode == "unicode":
        return _paste_unicode(text)

    # refocuses the target window before inserting (no-op if already foreground)
    if target_hwnd:
        focus_window(target_hwnd)
        time.sleep(0.05)

    used = _paste_clipboard(text)
    if used == "clipboard":
        # Ctrl+V was accepted by the system (4/4 events) — trust the delivery.
        # Logs what UIA reports for diagnostics only, without deciding.
        after = _focused_text()
        if after and text and text.strip() not in after:
            log.warning("UIA did not confirm the text (diagnostic, no fallback)")
        return used

    # clipboard actually failed (set or Ctrl+V) -> unicode
    log.warning("clipboard %s - unicode fallback", used)
    used = _paste_unicode(text)
    if mode == "unicode":
        return used
    # last resort: WM_PASTE straight to the focused control
    if target_hwnd:
        used_wm = _paste_wm(text, target_hwnd)
        if used_wm == "wm_paste":
            return used_wm
        log.warning("WM_PASTE %s - keeping unicode", used_wm)
    return used


# ── Panel overlay ─────────────────────────────────────────────────
PANEL_URL = "http://127.0.0.1:8700"
# page title fragment (web/index.html: "Dictação por Voz") —
# same match as the old PS '*Voz*'
_PANEL_TITLE_FRAGMENT = "Voz"

PANEL_W_COMPACT, PANEL_H_COMPACT = 860, 400
PANEL_W_EXPANDED, PANEL_H_EXPANDED = 860, 880
# width coupled to: web/src/App.tsx (resizeWindow) and platform/linux.py

_ENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)


def _find_panel_hwnd() -> int:
    """hwnd of the panel window (title contains the fragment) — 0 if not found.

    Direct EnumWindows (ctypes) instead of Get-Process/MainWindowTitle: faster
    and without depending on PowerShell for the F9 hot path.
    """
    found: list[int] = []

    def _cb(hwnd, _lparam) -> int:
        try:
            if not user32.IsWindowVisible(hwnd):
                return 1
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return 1
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if _PANEL_TITLE_FRAGMENT in buf.value:
                found.append(int(hwnd))
                return 0  # stop the enumeration
        except Exception:
            pass
        return 1

    try:
        user32.EnumWindows(_ENUMPROC(_cb), None)
    except Exception:
        log.exception("EnumWindows failed")
    return found[0] if found else 0


def _move_panel(hwnd: int, w: int, h: int, reapply: bool = False) -> None:
    """MoveWindow to (80,80). Edge may reapply restored bounds after the
    layout is ready — with reapply, repeats after 500ms."""
    user32.MoveWindow(hwnd, 80, 80, w, h, True)
    if reapply:
        time.sleep(0.5)
        user32.MoveWindow(hwnd, 80, 80, w, h, True)


def _spawn_edge_app(w: int, h: int) -> None:
    """Opens msedge --app (first opening). PowerShell ONLY here — the window
    focus afterwards is done in Python (focus_window).

    Dedicated profile (edge-profile): without it, Start-Process HANDS the
    command over to the resident Edge instance (StartupBoost keeps procs alive
    without a window) and neither honors --window-size nor separates from
    normal windows.
    """
    profile_dir = os.path.join(APP_DIR, "edge-profile")
    ps = (
        "Start-Process 'msedge.exe' -ArgumentList "
        f"'--app={PANEL_URL}','--window-size={w},{h}',"
        f"'--window-position=80,80','--user-data-dir={profile_dir}',"
        "'--no-first-run','--disable-sync'"
    )
    encoded = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
    subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-EncodedCommand", encoded],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def show_panel_window(expanded: bool = False) -> None:
    """Brings the panel window to the front; opens in app mode if absent.

    Called on F9/Shift+F9 and when recording starts. Silent failure —
    must never get in the way of dictation.

    Focus via focus_window (AttachThreadInput + SetForegroundWindow — same
    technique as paste): plain SwitchToThisWindow is ignored by the Windows
    foreground lock when the caller is in the background → it just flashed on the taskbar.
    """
    w, h = (
        (PANEL_W_EXPANDED, PANEL_H_EXPANDED)
        if expanded
        else (PANEL_W_COMPACT, PANEL_H_COMPACT)
    )
    try:
        hwnd = _find_panel_hwnd()
        if not hwnd:
            _spawn_edge_app(w, h)
            # waits for the window to appear (100ms poll, up to 6s)
            for _ in range(60):
                time.sleep(0.1)
                hwnd = _find_panel_hwnd()
                if hwnd:
                    break
        if not hwnd:
            log.warning("panel window not found after spawn")
            return
        if not focus_window(hwnd):
            # foreground still denied (rare) — last resort before the flash
            log.info("focus_window denied; SwitchToThisWindow fallback")
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:
                pass
        _move_panel(hwnd, w, h, reapply=True)
    except Exception:
        log.exception("show_panel_window failed (ignored)")


def resize_panel_window(width: int, height: int) -> None:
    """Resizes the panel window (compact ↔ expanded) via direct MoveWindow —
    no PowerShell subprocess (used to be ~200ms per layout toggle)."""
    try:
        hwnd = _find_panel_hwnd()
        if hwnd:
            user32.MoveWindow(hwnd, 80, 80, int(width), int(height), True)
    except Exception:
        log.exception("resize_panel_window failed (ignored)")


# ── ASR spawn (daemon auto-retry) ─────────────────────────────────
# Same decisions as supervisor.py: cwd "C:\" (UNC/WSL cwd breaks cmd.exe)
# and CREATE_NO_WINDOW so no console flashes when the daemon respawns
# the service. The uv trampoline is handled by the daemon itself (pidfile/port).
SPAWN_CWD = "C:\\"


def asr_command() -> list[str] | None:
    exe = venv_python()
    if not os.path.exists(exe):
        log.error("venv not found for ASR spawn: %s", exe)
        return None
    return [exe, "-m", "voice.asr_service", "--port", "8701"]


def popen_kwargs() -> dict:
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
