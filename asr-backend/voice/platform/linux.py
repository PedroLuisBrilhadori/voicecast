"""Linux backend (Wayland/Hyprland) — evdev + wl-clipboard/wtype.

Parity with the win32 backend:
  - hotkey: polling of /dev/input/event* (equivalent to GetAsyncKeyState) —
    requires the user in the `input` group (see the note's runbook/recommendations);
  - pasting: `wl-copy` (stays resident — Popen, never run()) +
    `wtype -k ctrl+v`; unicode fallback = `wtype "<text>"` (direct UTF-8,
    layout-independent);
  - beep: synthesized sine played via sounddevice (no kernel32.Beep);
  - focus: Wayland delivers keys to the focused window — foreground_hwnd is a no-op;
  - panel: browser in app mode (chromium/firefox) or xdg-open; resize is a no-op
    (the Hyprland windowrule covers it if needed).
"""

from __future__ import annotations

import glob
import json
import logging
import os
import select
import shutil
import struct
import subprocess
import threading
import time

import numpy as np

from voice.platform.common import host_src, venv_python

log = logging.getLogger("voice-dictate")

PANEL_URL = "http://127.0.0.1:8700"
SPAWN_CWD = "/"
HOST_SRC = host_src()

# ── Hotkey via evdev ──────────────────────────────────────────────
EV_KEY = 0x01
# input_event em x86_64: tv_sec(8)+tv_usec(8)+type(2)+code(2)+value(4)
_INPUT_EVENT = (
    struct.Struct("llHHi") if struct.calcsize("l") == 8 else struct.Struct("iiHHi")
)

# evdev: KEY_F1..KEY_F10 = 59..68 (consecutivos); F11=87, F12=88.
# Fonte: /usr/include/linux/input-event-codes.h
VK_TO_EVDEV_FKEYS = {0x70 + i: 59 + i for i in range(10)}  # F1..F10
VK_TO_EVDEV_FKEYS.update({0x7A: 87, 0x7B: 88})  # F11, F12

# Modifiers tracked for the Shift+F9 combo (open the panel without recording)
KEY_LEFTSHIFT = 42
KEY_RIGHTSHIFT = 54
_SHIFT_CODES = {KEY_LEFTSHIFT, KEY_RIGHTSHIFT}


def _keycode_from_vk(vk: int) -> int:
    """VKCode -> evdev code. Only F1..F12 mapped; env override."""
    env = os.environ.get("VOICE_HOTKEY_KEYCODE", "").strip()
    if env.isdigit():
        return int(env)
    if vk in VK_TO_EVDEV_FKEYS:
        return VK_TO_EVDEV_FKEYS[vk]
    return 67  # KEY_F9 (plugin default)


class _EvdevHotkey:
    """Tracks the dictation key state by reading /dev/input/event* directly.

    A single thread scans all devices in non-blocking mode; EV_KEY events
    with the target code update `_down`. Without permission (input group),
    warns once and retries a periodic rescan.
    """

    def __init__(self, keycode: int) -> None:
        self.keycode = keycode
        self._down = False
        self._shift_down = False
        self._lock = threading.Lock()
        self._started = False
        self._warned_no_perm = False
        self._logged_total = False

    def pressed(self) -> bool:
        if not self._started:
            self._started = True
            threading.Thread(target=self._run, daemon=True, name="evdev-hotkey").start()
        with self._lock:
            return self._down

    def shift_pressed(self) -> bool:
        """Global Shift state — evdev events arrive in physical order,
        so a Shift pressed before F9 is already set when the poll
        (~12ms) reads both states together."""
        if not self._started:
            self._started = True
            threading.Thread(target=self._run, daemon=True, name="evdev-hotkey").start()
        with self._lock:
            return self._shift_down

    def _run(self) -> None:
        fds: dict[int, str] = {}
        last_scan = 0.0
        while True:
            now = time.monotonic()
            if now - last_scan >= 5.0:
                last_scan = now
                # unconditional periodic re-scan: adopts keyboards born
                # after boot (USB/BT hotplug, remote-session uinput —
                # RustDesk recreates the devices on every connection)
                fds = self._rescan(fds)
            if not fds:
                time.sleep(1.0)
                continue
            try:
                ready, _, _ = select.select(list(fds), [], [], 0.05)
            except OSError:
                fds = self._close_all(fds)
                continue
            dead = False
            for fd in ready:
                try:
                    data = os.read(fd, 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    # device vanished (BT/USB): close ONLY that one and move on;
                    # the periodic re-scan brings back whoever is reborn
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    fds.pop(fd, None)
                    dead = True
                    continue
                self._consume(data)

    def _scan_devices(self) -> dict[int, str]:
        return self._rescan({})

    def _rescan(self, fds: dict[int, str]) -> dict[int, str]:
        """Syncs the open fds with the existing /dev/input/event* devices.

        Without this, a keyboard created after the first scan (USB/BT dongle
        plugged in, remote-session uinput) is never monitored — the F9 reaches
        the kernel but the daemon doesn't read it.
        """
        current = set(glob.glob("/dev/input/event*"))
        # devices that vanished (unplug / end of remote session)
        for fd in [f for f, p in fds.items() if p not in current]:
            try:
                os.close(fd)
            except OSError:
                pass
            del fds[fd]
        # new devices (hotplug)
        opened = set(fds.values())
        had_fds = bool(fds)
        added, denied = 0, 0
        for path in sorted(current - opened):
            try:
                fds[os.open(path, os.O_RDONLY | os.O_NONBLOCK)] = path
                added += 1
            except PermissionError:
                denied += 1
            except OSError:
                continue
        if added and had_fds:
            log.info(
                "hotkey evdev: +%d device(s) adopted (hotplug), total=%d",
                added, len(fds),
            )
        if not fds and denied and not self._warned_no_perm:
            self._warned_no_perm = True
            log.error(
                "no permission to read /dev/input/event* (%d devices denied) — "
                "add the user to the input group: sudo usermod -aG input %s "
                "(re-login required). Hotkey does NOT work until then.",
                denied, os.environ.get("USER", "?"),
            )
        elif fds and not self._logged_total:
            # first successful scan logs the total; later
            # adoptions get their own log (avoids spam every 5s)
            self._logged_total = True
            log.info(
                "hotkey evdev: %d device(s) monitored, keycode=%d",
                len(fds), self.keycode,
            )
        return fds

    def _consume(self, data: bytes) -> None:
        size = _INPUT_EVENT.size
        for off in range(0, len(data) - size + 1, size):
            _, _, ev_type, code, value = _INPUT_EVENT.unpack(data[off : off + size])
            if ev_type != EV_KEY:
                continue
            if code == self.keycode:
                with self._lock:
                    self._down = value != 0  # 1=press, 2=repeat, 0=release
            elif code in _SHIFT_CODES:
                with self._lock:
                    self._shift_down = value != 0

    @staticmethod
    def _close_all(fds: dict[int, str]) -> dict[int, str]:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass
        return {}


_hotkey: _EvdevHotkey | None = None


def _get_hotkey() -> _EvdevHotkey:
    global _hotkey
    if _hotkey is None:
        from voice.config import VoiceConfig  # configurable hotkey (hotkey_vk)

        try:
            vk = VoiceConfig().get()["hotkey_vk"]
        except Exception:
            vk = 0x78
        _hotkey = _EvdevHotkey(_keycode_from_vk(int(vk)))
    return _hotkey


def f9_pressed() -> bool:
    return _get_hotkey().pressed()


def shift_pressed() -> bool:
    return _get_hotkey().shift_pressed()


def beep(freq: int, ms: int) -> None:
    """Synthesized beep played via pw-play (PipeWire client).

    Do NOT use sounddevice/PortAudio here: system portaudio is ALSA-only and,
    when opening the default device, may hold the hw PCM (pcmC0D0p) with mmap
    even after the stream ends — it blocks PipeWire and the system goes mute
    (the sink falls back to the dummy "Saída de falsa"). pw-play is a PipeWire
    client: it never opens /dev/snd directly, so there is no blocking risk.
    """
    try:
        import io
        import shutil
        import subprocess
        import wave as wavmod
        from pathlib import Path

        player = shutil.which("pw-play") or shutil.which("paplay")
        if not player:
            log.warning("beep skipped: no pw-play/paplay in PATH")
            return

        sr = 44100
        n = max(int(sr * ms / 1000), 32)
        t = np.arange(n, dtype=np.float32) / sr
        wave = np.sin(2 * np.pi * freq * t).astype(np.float32) * 0.3
        edge = min(n // 4, int(sr * 0.005)) or 1
        wave[:edge] *= np.linspace(0, 1, edge, dtype=np.float32)
        wave[-edge:] *= np.linspace(1, 0, edge, dtype=np.float32)

        # cache in /tmpfs: generates the wav 1x per boot per (freq, ms); avoids
        # re-synthesizing on every F9 and needs no cleanup (gone on reboot)
        cache = Path("/dev/shm/voice-dictation-beeps")
        cache.mkdir(exist_ok=True)
        path = cache / f"{freq}-{ms}.wav"
        if not path.exists():
            buf = io.BytesIO()
            with wavmod.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes((wave * 32767).astype("<i2").tobytes())
            buf.seek(0)
            path.write_bytes(buf.read())

        # fire-and-forget detached from the daemon (inherits no fds, doesn't die with it)
        subprocess.Popen(
            [player, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        log.exception("beep failed (ignored)")


# ── Focus / target window ─────────────────────────────────────────
def foreground_hwnd() -> int:
    """No-op on Wayland: the focused window receives the keys naturally."""
    return 0


def window_info(hwnd: int) -> str:
    return ""


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # process exists, but belongs to another user
    except OSError:
        return False


# ── Pasting ───────────────────────────────────────────────────────
def _have(bin_name: str) -> bool:
    return shutil.which(bin_name) is not None


def set_clipboard(text: str) -> bool:
    """wl-copy STAYS resident to serve future pastes — Popen without wait."""
    if not _have("wl-copy"):
        log.warning("wl-copy not found (wl-clipboard package)")
        return False
    try:
        subprocess.Popen(
            ["wl-copy", "--", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except Exception:
        log.exception("wl-copy failed")
        return False


def _wtype(args: list[str]) -> bool:
    if not _have("wtype"):
        log.warning(
            "wtype not found (community/wtype package) — pasting unavailable"
        )
        return False
    try:
        proc = subprocess.run(["wtype", *args], capture_output=True, timeout=10)
        if proc.returncode != 0:
            log.info(
                "wtype rc=%s stderr=%s", proc.returncode,
                proc.stderr.decode(errors="replace").strip()[:160],
            )
        return proc.returncode == 0
    except Exception:
        log.exception("wtype failed")
        return False


# KWin (KDE) doesn't implement wtype's virtual keyboard protocol — the
# fallback is ydotool (uinput, via the user's ydotoold; ydotool.service unit)
_YDOTOOL_SOCKET = os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/run/user/1000"), ".ydotool_socket"
)


def _ydotool(args: list[str]) -> bool:
    if not _have("ydotool"):
        log.info("ydotool missing from PATH")
        return False
    try:
        proc = subprocess.run(
            ["ydotool", *args],
            capture_output=True,
            timeout=10,
            env={**os.environ, "YDOTOOL_SOCKET": _YDOTOOL_SOCKET},
        )
        if proc.returncode != 0:
            log.info(
                "ydotool rc=%s stderr=%s", proc.returncode,
                proc.stderr.decode(errors="replace").strip()[:160],
            )
        return proc.returncode == 0
    except Exception:
        log.exception("ydotool failed")
        return False


def _foco_ativo() -> str:
    """Name of the active X11/XWayland window — pasting diagnostics (empty focus
    = focus on a native Wayland window, invisible to xprop)."""
    try:
        out = subprocess.run(
            ["xprop", "-root", "_NET_ACTIVE_WINDOW"],
            capture_output=True, timeout=2,
        )
        win = out.stdout.decode(errors="replace").split("=")[-1].strip()
    except Exception as exc:
        return f"(xprop unavailable: {exc})"
    if win in ("0x0", ""):
        return "none (focus on a native Wayland window or lock screen)"
    try:
        nome = subprocess.run(
            ["xdotool", "getwindowname", win],
            capture_output=True, timeout=2,
        )
        return f"{win} «{nome.stdout.decode(errors='replace').strip()}»"
    except Exception:
        return win


def _paste_ctrl_v() -> bool:
    log.info("paste: active focus: %s", _foco_ativo())
    if _wtype(["-M", "Ctrl", "-k", "v", "-m", "Ctrl"]):
        return True
    # evdev: 29=LeftCtrl, 47=KEY_V (25 is KEY_P — "Ctrl+V" with 25 pressed
    # Ctrl+P and the paste never landed; bug from the ydotool migration)
    ok = _ydotool(["key", "29:1", "47:1", "47:0", "29:0"])
    log.info("paste: ydotool ctrl+v ok=%s", ok)
    return ok


def _clipboard_registrado(text: str, timeout_s: float = 0.6) -> bool:
    """Waits for wl-copy to show up as the clipboard source (poll via wl-paste).

    Ctrl+V only pastes what the compositor has already registered: if the
    injection wins the race against the registration, the target receives the
    OLD clipboard (or nothing) — and the user's later manual paste works,
    because by then the source is in place. Returns False on timeout (the
    caller decides: inject anyway, fail-soft).
    """
    if not _have("wl-paste"):
        log.warning("wl-paste not found — no registration check")
        time.sleep(0.1)
        return False
    deadline = time.monotonic() + timeout_s
    attempt, delay = 0, 0.03
    while time.monotonic() < deadline:
        try:
            cur = subprocess.run(
                ["wl-paste", "--no-newline"],
                capture_output=True, timeout=2,
            )
            if cur.returncode == 0 and cur.stdout.decode("utf-8", "replace") == text:
                log.info("clipboard registered after %.0fms (%d polls)",
                         (timeout_s - (deadline - time.monotonic())) * 1000, attempt)
                return True
        except Exception:
            pass
        attempt += 1
        time.sleep(delay)
        delay = min(delay * 1.6, 0.08)
    log.warning("clipboard did not confirm registration in %.0fs (%d polls) — injecting anyway", timeout_s, attempt)
    return False


def _paste_clipboard(text: str) -> str:
    if not set_clipboard(text):
        return "clipboard-set-falhou"
    # waits for the source to be actually registered in the compositor before Ctrl+V (the
    # fixed 50ms sleep was losing the race and the target pasted an old/empty clipboard)
    _clipboard_registrado(text)
    if not _paste_ctrl_v():
        return "ctrl-v-bloqueado"
    return "clipboard"


def _paste_unicode(text: str) -> str:
    if _wtype([text]):
        return "unicode"
    return "unicode" if _ydotool(["type", "--", text]) else "unicode-falhou"


def paste_into_focused(text: str, mode: str, target_hwnd: int) -> str:
    """Inserts into the focused window. Same semantics as win32: ONE insertion per
    dictation — clipboard→unicode only if the previous step actually failed."""
    if mode == "unicode":
        return _paste_unicode(text)

    used = _paste_clipboard(text)
    if used == "clipboard":
        return used
    log.warning("clipboard %s - unicode fallback", used)
    return _paste_unicode(text)


# ── Panel overlay ─────────────────────────────────────────────────
PANEL_TITLE = "Dictação por Voz"

# A freshly opened window doesn't match by title yet (chromium only sets
# the page title after loading; before that it's initialTitle=URL) —
# the cooldown avoids opening a SECOND window in that gap.
_PANEL_SPAWN_COOLDOWN_S = 5.0
_panel_spawn_lock = threading.Lock()
_panel_spawn_at = 0.0  # time.monotonic() of the last spawn (0 = never spawned)


def _hypr_sigs() -> list[str]:
    """Hyprland instance signatures to try, most recent first.

    The service may start before autostart imports
    HYPRLAND_INSTANCE_SIGNATURE into the systemd user session — or survive a
    Hyprland restart, which changes the signature. In those states plain
    `hyprctl` fails ("HYPRLAND_INSTANCE_SIGNATURE not set!" / dead socket) and
    the panel used to spawn a new window on every F9. Live instances are
    discovered via the sockets in $XDG_RUNTIME_DIR/hypr/<sig>/.socket.sock.
    """
    sigs: list[str] = []
    env_sig = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", "").strip()
    if env_sig:
        sigs.append(env_sig)
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if runtime:
        sockets = glob.glob(os.path.join(runtime, "hypr", "*", ".socket.sock"))
        try:
            sockets.sort(key=os.path.getmtime, reverse=True)
        except OSError:
            pass
        for sock in sockets:
            sig = os.path.basename(os.path.dirname(sock))
            if sig and sig not in sigs:
                sigs.append(sig)
    return sigs


def _hyprctl(sig: str, *args: str) -> str | None:
    """runs `hyprctl -i <sig> ...`; stdout (str) on success, None on failure."""
    try:
        out = subprocess.run(
            ["hyprctl", "-i", sig, *args], capture_output=True, timeout=3
        )
    except Exception:
        return None
    if out.returncode != 0 or not out.stdout:
        return None
    return out.stdout.decode(errors="replace")


def _focus_hypr_addr(sig: str, addr: str) -> bool:
    """Focuses window <addr> on instance <sig>; success only with an 'ok' reply.

    Hyprland >= 0.56 (lua IPC) rejects the classic
    `dispatch focuswindow address:X` request with a Lua syntax error — the new
    form is `eval hl.dispatch(hl.dsp.focus({window='address:X'}))`. We try the
    new one first and fall back to the classic (pre-0.56 instances).
    "warning:" replies (window vanished between clients and the focus) don't
    count as success.
    """
    replies = [
        _hyprctl(
            sig,
            "eval",
            f"hl.dispatch(hl.dsp.focus({{ window = 'address:{addr}' }}))",
        ),
        _hyprctl(sig, "dispatch", "focuswindow", f"address:{addr}"),
    ]
    return any(out and out.strip().startswith("ok") for out in replies)


def _focus_existing_panel() -> bool:
    """Focuses the panel window if it already exists (Hyprland IPC). True if found.

    Without this, every recording opened ANOTHER browser window in app mode.
    """
    ipc_ok = False
    for sig in _hypr_sigs():
        raw = _hyprctl(sig, "clients", "-j")
        if raw is None:
            continue
        try:
            clients = json.loads(raw)
        except Exception:
            continue
        ipc_ok = True
        for c in clients:
            if PANEL_TITLE in str(c.get("title") or ""):
                addr = str(c.get("address") or "")
                if addr and _focus_hypr_addr(sig, addr):
                    return True
    if not ipc_ok:
        log.warning(
            "panel: Hyprland IPC unreachable — focusing the existing window "
            "failed (sigs tried: %s)", _hypr_sigs() or "none",
        )
    return False


def show_panel_window(expanded: bool = False) -> None:
    """Focuses the existing panel window; opens in app mode only if absent."""
    # width coupled to: web/src/App.tsx (resizeWindow) and platform/win32.py
    w, h = (
        (860, 880) if expanded else (860, 400)
    )
    global _panel_spawn_at
    with _panel_spawn_lock:
        if _focus_existing_panel():
            _panel_spawn_at = 0.0
            return
        if time.monotonic() - _panel_spawn_at < _PANEL_SPAWN_COOLDOWN_S:
            log.info("panel: recent window still opening — spawn in cooldown")
            return
        candidates = [
            ["chromium", f"--app={PANEL_URL}", f"--window-size={w},{h}"],
            ["google-chrome-stable", f"--app={PANEL_URL}", f"--window-size={w},{h}"],
            ["firefox", "--new-window", PANEL_URL],
            ["xdg-open", PANEL_URL],
        ]
        for argv in candidates:
            exe = shutil.which(argv[0])
            if exe:
                try:
                    subprocess.Popen(
                        [exe, *argv[1:]],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    _panel_spawn_at = time.monotonic()
                    return
                except Exception:
                    continue
        log.warning("no browser to open the panel %s (ignored)", PANEL_URL)


def resize_panel_window(width: int, height: int) -> None:
    """No-op on Linux — pin size/position with a Hyprland windowrule."""


# ── ASR spawn ─────────────────────────────────────────────────────
def asr_command() -> list[str] | None:
    exe = venv_python()
    if not os.path.exists(exe):
        log.error("venv not found for ASR spawn: %s", exe)
        return None
    return [exe, "-m", "voice.asr_service", "--port", "8701"]


def popen_kwargs() -> dict:
    return {"start_new_session": True}
