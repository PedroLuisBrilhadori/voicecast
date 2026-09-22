"""Backend Windows — código Win32 (ctypes) do ditado por voz.

Movido VERBATIM de dictation_daemon.py (2026-08): SendInput (struct INPUT
com union — cbSize 40 no x64), clipboard CF_UNICODETEXT, focus_window sem
"ALT trick", WM_PASTE, UIA como diagnóstico, GetAsyncKeyState para a hotkey,
kernel32.Beep e overlay do painel via PowerShell + msedge --app.

Qualquer regressão no Windows: comparar com o histórico do arquivo
dictation_daemon.py antes da refatoração platform/.
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
    """Struct INPUT do Win32 (x64 = 40 bytes). Sem a union, o cbSize fica 32
    (errado) e o SendInput falha com ERROR_INVALID_PARAMETER (retorna 0)."""
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
    """Envia eventos de teclado via SendInput. Retorna quantos foram aceitos."""
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
    """Digita texto caractere a caractere via KEYEVENTF_UNICODE (teclado real)."""
    events: list[INPUT] = []
    for ch in text:
        scan = ord(ch)
        events.append(_input(0, scan, KEYEVENTF_UNICODE))
        events.append(_input(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    _send_input(events)


def scan_code(vk: int) -> int:
    return user32.MapVirtualKeyW(vk, 0)


def send_ctrl_v() -> int:
    """Ctrl+V com scan codes. Retorna quantos eventos o Windows aceitou (4 = ok)."""
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
    """Estado GLOBAL do Shift (independe da janela em foco) — Shift+F9 abre o
    painel sem gravar. Mesma janela de polling do F9 (~12ms)."""
    return bool(user32.GetAsyncKeyState(VK_SHIFT) & 0x8000)


def ctrl_pressed() -> bool:
    """Estado GLOBAL do Ctrl — combos com Ctrl pertencem ao voicecast (v2)."""
    return bool(user32.GetAsyncKeyState(VK_CONTROL) & 0x8000)


def beep(freq: int, ms: int) -> None:
    kernel32.Beep(freq, ms)


# ── Foco / janela alvo ────────────────────────────────────────────
def foreground_hwnd() -> int:
    return int(user32.GetForegroundWindow())


def window_info(hwnd: int) -> str:
    """'título (pid)' da janela — para diagnóstico."""
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
    """Garante que hwnd é a janela foreground.

    Se já é foreground, não faz nada (evita ALT/menus). Caso contrário usa
    AttachThreadInput + BringWindowToTop + SetForegroundWindow — sem o "ALT
    trick", que ativa a barra de menu em apps como o Notepad e desvia o input.
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
        log.exception("focus_window falhou")
        return False


def pid_alive(pid: int) -> bool:
    """True se o processo Windows com este PID ainda existe (via OpenProcess)."""
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


# ── Clipboard / colagem ───────────────────────────────────────────
# tipos Win32 para ponteiros (GlobalAlloc/GlobalLock devolvem HGLOBAL 64-bit;
# sem restype/argtypes o ctypes trunca para c_int e corrompe o handle)
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
    """Coloca texto no clipboard via API Win32 (CF_UNICODETEXT), sem clip.exe."""
    try:
        if not user32.OpenClipboard(None):
            log.warning("OpenClipboard falhou")
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
        log.exception("set_clipboard falhou")
        return False


def _paste_clipboard(text: str) -> str:
    """clipboard Win32 + Ctrl+V com scan codes. Retorna 'ok' ou 'falha'."""
    if not set_clipboard(text):
        return "clipboard-set-falhou"
    n = send_ctrl_v()
    if n >= 4:
        return "clipboard"
    log.warning("Ctrl+V entregou %d/4 eventos", n)
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
    """Ultimo recurso: WM_PASTE direto no controle em foco da janela alvo
    (apps que ignoram teclado sintetizado). Requer foco na janela."""
    if not set_clipboard(text):
        return "wm-clipboard-falhou"
    try:
        focus_window(hwnd)
        info = GUITHREADINFO()
        info.cbSize = ctypes.sizeof(GUITHREADINFO)
        tid = user32.GetWindowThreadProcessId(hwnd, None)
        if not user32.GetGUIThreadInfo(tid, ctypes.byref(info)):
            log.warning("GetGUIThreadInfo falhou - WM_PASTE na janela raiz")
            user32.SendMessageW(hwnd, WM_PASTE, 0, 0)
            return "wm_paste"
        child = int(info.hwndFocus) or hwnd
        res = user32.SendMessageW(child, WM_PASTE, 0, 0)
        return "wm_paste" if res else "wm-paste-falhou"
    except Exception:
        log.exception("WM_PASTE falhou")
        return "wm-paste-falhou"


def _focused_text() -> str:
    """Texto do controle em foco via UIAutomation. Vazio se indisponível."""
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
    """Insere o texto na janela alvo. Retorna o modo efetivamente usado.

    Uma unica insercao por ditado: se o Ctrl+V foi entregue (4/4) assumimos
    sucesso. NAO re-digitamos via unicode com base em heuristica UIA — apps
    Electron (Discord) nao expoem o conteudo e a checagem gerava duplicacao.
    """
    log.info("alvo da insercao: %s", window_info(target_hwnd))

    if mode == "unicode":
        return _paste_unicode(text)

    # refoca a janela alvo antes de inserir (no-op se ja e foreground)
    if target_hwnd:
        focus_window(target_hwnd)
        time.sleep(0.05)

    used = _paste_clipboard(text)
    if used == "clipboard":
        # Ctrl+V foi aceito pelo sistema (4/4 eventos) — confia na entrega.
        # Registra o que o UIA reporta so para diagnostico, sem decidir.
        after = _focused_text()
        if after and text and text.strip() not in after:
            log.warning("UIA nao confirmou o texto (diagnostico, sem fallback)")
        return used

    # clipboard falhou de fato (set ou Ctrl+V) -> unicode
    log.warning("clipboard %s - fallback unicode", used)
    used = _paste_unicode(text)
    if mode == "unicode":
        return used
    # ultimo recurso: WM_PASTE direto ao controle em foco
    if target_hwnd:
        used_wm = _paste_wm(text, target_hwnd)
        if used_wm == "wm_paste":
            return used_wm
        log.warning("WM_PASTE %s - mantem unicode", used_wm)
    return used


# ── Overlay do painel ─────────────────────────────────────────────
PANEL_URL = "http://127.0.0.1:8700"
# fragmento do título da página (web/index.html: "Dictação por Voz") —
# mesmo match que o antigo PS '*Voz*'
_PANEL_TITLE_FRAGMENT = "Voz"

PANEL_W_COMPACT, PANEL_H_COMPACT = 860, 400
PANEL_W_EXPANDED, PANEL_H_EXPANDED = 860, 880
# largura acoplada a: web/src/App.tsx (resizeWindow) e platform/linux.py

_ENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)


def _find_panel_hwnd() -> int:
    """hwnd da janela do painel (título contém o fragmento) — 0 se não achar.

    EnumWindows direto (ctypes) no lugar de Get-Process/MainWindowTitle: mais
    rápido e sem depender de PowerShell para o caminho quente do F9.
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
                return 0  # para a enumeração
        except Exception:
            pass
        return 1

    try:
        user32.EnumWindows(_ENUMPROC(_cb), None)
    except Exception:
        log.exception("EnumWindows falhou")
    return found[0] if found else 0


def _move_panel(hwnd: int, w: int, h: int, reapply: bool = False) -> None:
    """MoveWindow em (80,80). O Edge pode reaplicar bounds restaurados depois
    do layout pronto — com reapply, repete após 500ms."""
    user32.MoveWindow(hwnd, 80, 80, w, h, True)
    if reapply:
        time.sleep(0.5)
        user32.MoveWindow(hwnd, 80, 80, w, h, True)


def _spawn_edge_app(w: int, h: int) -> None:
    """Abre msedge --app (primeira abertura). PowerShell SÓ aqui — o foco da
    janela depois é feito em Python (focus_window).

    Perfil dedicado (edge-profile): sem ele, o Start-Process ENTREGA o comando
    para a instância residente do Edge (StartupBoost mantém procs vivos sem
    janela) e não honra --window-size nem separa das janelas normais.
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
    """Traz a janela do painel à frente; abre em modo app se não existir.

    Chamado no F9/Shift+F9 e quando a gravação começa. Falha silenciosa —
    nunca pode atrapalhar o ditado.

    Foco via focus_window (AttachThreadInput + SetForegroundWindow — mesma
    técnica do paste): SwitchToThisWindow puro é ignorado pelo foreground lock
    do Windows quando o chamador está em background → só piscava na taskbar.
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
            # espera a janela surgir (poll 100ms, até 6s)
            for _ in range(60):
                time.sleep(0.1)
                hwnd = _find_panel_hwnd()
                if hwnd:
                    break
        if not hwnd:
            log.warning("janela do painel nao encontrada apos spawn")
            return
        if not focus_window(hwnd):
            # foreground ainda negado (raro) — último recurso antes do flash
            log.info("focus_window negou; fallback SwitchToThisWindow")
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:
                pass
        _move_panel(hwnd, w, h, reapply=True)
    except Exception:
        log.exception("show_panel_window falhou (ignorado)")


def resize_panel_window(width: int, height: int) -> None:
    """Redimensiona a janela do painel (compacto ↔ expandido) via MoveWindow
    direto — sem subprocess PowerShell (era ~200ms por toggle de layout)."""
    try:
        hwnd = _find_panel_hwnd()
        if hwnd:
            user32.MoveWindow(hwnd, 80, 80, int(width), int(height), True)
    except Exception:
        log.exception("resize_panel_window falhou (ignorado)")


# ── Spawn do ASR (auto-retry do daemon) ───────────────────────────
# Mesmas decisões do supervisor.py: cwd "C:\" (cwd UNC/WSL quebra o cmd.exe)
# e CREATE_NO_WINDOW para nenhum console piscar quando o daemon respawnar
# o serviço. O trampoline do uv é tratado pelo próprio daemon (pidfile/porta).
SPAWN_CWD = "C:\\"


def asr_command() -> list[str] | None:
    exe = venv_python()
    if not os.path.exists(exe):
        log.error("venv não encontrado para spawn do ASR: %s", exe)
        return None
    return [exe, "-m", "voice.asr_service", "--port", "8701"]


def popen_kwargs() -> dict:
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
