"""Camada de plataforma do voice-dictation.

`get_backend()` devolve um `Backend` imutável com as funções específicas de
SO usadas pelo daemon/ASR. O resto do código é agnóstico — a seleção é feita
por `sys.platform` ("win32" → win32; qualquer outro → linux).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Backend:
    name: str
    beep: Callable[[int, int], None]
    f9_pressed: Callable[[], bool]
    shift_pressed: Callable[[], bool]
    paste_into_focused: Callable[[str, str, int], str]
    foreground_hwnd: Callable[[], int]
    window_info: Callable[[int], str]
    pid_alive: Callable[[int], bool]
    show_panel_window: Callable[[bool], None]
    resize_panel_window: Callable[[int, int], None]
    asr_command: Callable[[], list[str] | None]
    spawn_cwd: str
    popen_kwargs: Callable[[], dict]


def get_backend() -> Backend:
    if sys.platform == "win32":
        from voice.platform import win32 as impl
    else:
        from voice.platform import linux as impl
    return Backend(
        name="win32" if sys.platform == "win32" else "linux",
        beep=impl.beep,
        f9_pressed=impl.f9_pressed,
        shift_pressed=impl.shift_pressed,
        paste_into_focused=impl.paste_into_focused,
        foreground_hwnd=impl.foreground_hwnd,
        window_info=impl.window_info,
        pid_alive=impl.pid_alive,
        show_panel_window=impl.show_panel_window,
        resize_panel_window=impl.resize_panel_window,
        asr_command=impl.asr_command,
        spawn_cwd=impl.SPAWN_CWD,
        popen_kwargs=impl.popen_kwargs,
    )
