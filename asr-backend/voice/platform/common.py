"""Backend-independent paths and helpers, shared by win32/linux.

app_dir() is the plugin's data root:
  - Windows: %LOCALAPPDATA%/voice-dictation (historical behavior)
  - Linux:   ${XDG_DATA_HOME:-~/.local/share}/voice-dictation

Every module that writes to disk (config, dataset, history, logs,
pidfiles) goes through here — never builds the path directly.
"""

from __future__ import annotations

import os
import sys


def app_dir() -> str:
    # VOICE_APP_DIR: voicecast hosts this backend and points the data root
    # to %LOCALAPPDATA%\voicecast\asr-backend. Without the env, historical
    # voice-dictation behavior.
    override = os.environ.get("VOICE_APP_DIR")
    if override:
        return override
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", ".")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
    return os.path.join(base, "voice-dictation")


def venv_python(venv_dir: str | None = None) -> str:
    """Path of the python inside the plugin's venv (Scripts\\ on Windows)."""
    venv = venv_dir or os.path.join(app_dir(), ".venv")
    if sys.platform == "win32":
        return os.path.join(venv, "Scripts", "python.exe")
    return os.path.join(venv, "bin", "python")


def host_src() -> str:
    """Source code synced/executable on the host (ASR spawn).

    Windows: copy made by install-tasks.ps1 (%LOCALAPPDATA%).
    Linux: the repo itself runs via PYTHONPATH — spawn uses the same src.
    """
    if sys.platform == "win32":
        return os.path.join(app_dir(), "src")
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
