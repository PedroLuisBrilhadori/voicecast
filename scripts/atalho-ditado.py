#!/usr/bin/env python3
"""atalho-ditado — evdev watcher for the F9 key that triggers the voicecast toggle.

The KDE Wayland GlobalShortcuts portal is not deterministic with Electron
(register ok=true, KWin never binds the key) — this watcher reads F9 DIRECTLY
from evdev (read-only, no grab: the keyboard keeps working normally for the
whole system) and runs `kde-toggle.sh ditado` (2nd instance signals the live
one and exits).

Modes: (default) watch · --check (prerequisites, read-only) · --selftest.
Exit: 0 ok · 1 error · 2 missing prerequisite.
"""

from __future__ import annotations

import array
import fcntl
import glob
import os
import select
import struct
import subprocess
import sys
import time

KEY_F9 = 67
EV_KEY = 0x01
DEBOUNCE_S = 0.8

KDE_TOGGLE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "kde-toggle.sh"
)

_INPUT_EVENT = (
    struct.Struct("llHHi") if struct.calcsize("l") == 8 else struct.Struct("iiHHi")
)


def _ioc(tipo: int, nr: int, size: int) -> int:
    return (2 << 30) | (size << 16) | (tipo << 8) | nr


EVIOCGBIT_KEY = _ioc(ord("E"), 0x20 + EV_KEY, 96)


def teclados() -> list[str]:
    """Paths of devices that look like keyboards (KEY_A/KEY_ENTER/KEY_SPACE)."""
    out: list[str] = []
    for path in sorted(glob.glob("/dev/input/event*")):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            bits = array.array("b", bytes(96))
            fcntl.ioctl(fd, EVIOCGBIT_KEY, bits, True)
            b = bits.tobytes()
            if any(b[c // 8] & (1 << (c % 8)) for c in (30, 28, 57)):
                out.append(path)
        except OSError:
            continue
        finally:
            os.close(fd)
    return out


def dispara() -> None:
    subprocess.Popen(
        [KDE_TOGGLE, "ditado"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def vigia(log=print) -> int:
    fds: dict[int, str] = {}
    ultimo = 0.0
    ultimo_scan = 0.0
    log(f"F9 watcher active → {KDE_TOGGLE} ditado")
    while True:
        agora = time.monotonic()
        if agora - ultimo_scan >= 5.0:
            ultimo_scan = agora
            atuais = set(teclados())
            for fd, path in list(fds.items()):
                orfao = False
                try:
                    # device node recriado (re-enumeration): fd aponta para
                    # inode unlinked que não recebe mais eventos
                    orfao = os.fstat(fd).st_nlink == 0
                except OSError:
                    orfao = True
                if path not in atuais or orfao:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    del fds[fd]
            for path in atuais - set(fds.values()):
                try:
                    fds[os.open(path, os.O_RDONLY | os.O_NONBLOCK)] = path
                except OSError:
                    continue
        if not fds:
            time.sleep(1.0)
            continue
        try:
            prontos, _, _ = select.select(list(fds), [], [], 1.0)
        except OSError:
            fds = {}
            continue
        for fd in prontos:
            try:
                data = os.read(fd, 4096)
            except (BlockingIOError, OSError):
                continue
            size = _INPUT_EVENT.size
            for off in range(0, len(data) - size + 1, size):
                _, _, ev_tipo, codigo, valor = _INPUT_EVENT.unpack(
                    data[off : off + size]
                )
                if ev_tipo == EV_KEY and codigo == KEY_F9 and valor == 1:
                    if time.monotonic() - ultimo >= DEBOUNCE_S:
                        ultimo = time.monotonic()
                        log("F9 → ditado toggle")
                        dispara()


def cmd_check() -> int:
    t = teclados()
    ok_grp = bool(t)
    print(f"[{'✓' if ok_grp else '✗'}] evdev keyboards readable: {len(t)}")
    ok_bin = os.access(KDE_TOGGLE, os.X_OK)
    print(f"[{'✓' if ok_bin else '✗'}] kde-toggle.sh executable: {KDE_TOGGLE}")
    falha = not (ok_grp and ok_bin)
    print("CHECK: " + ("FAILED (input group? re-login)" if falha else "ok"))
    return 2 if falha else 0


def selftest() -> int:
    import io  # noqa: F401
    ev = _INPUT_EVENT.pack(0, 0, EV_KEY, KEY_F9, 1)
    _, _, t, c, v = _INPUT_EVENT.unpack(ev)
    assert (t, c, v) == (EV_KEY, KEY_F9, 1), "pack/unpack F9"
    ev0 = _INPUT_EVENT.pack(0, 0, EV_KEY, KEY_F9, 0)
    assert _INPUT_EVENT.unpack(ev0)[4] == 0, "release"
    assert os.path.exists(KDE_TOGGLE), "kde-toggle.sh missing"
    print("SELFTEST: ok")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if "--check" in argv:
        return cmd_check()

    def log(msg: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    return vigia(log)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
