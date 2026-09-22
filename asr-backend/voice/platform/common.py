"""Paths e helpers independentes de backend, compartilhados por win32/linux.

app_dir() é a raiz de dados do plugin:
  - Windows: %LOCALAPPDATA%/voice-dictation (comportamento histórico)
  - Linux:   ${XDG_DATA_HOME:-~/.local/share}/voice-dictation

Todos os módulos que gravam em disco (config, dataset, history, logs,
pidfiles) passam por aqui — nunca montam o path diretamente.
"""

from __future__ import annotations

import os
import sys


def app_dir() -> str:
    # VOICE_APP_DIR: o voicecast hospeda este backend e aponta a raiz de dados
    # para %LOCALAPPDATA%\voicecast\asr-backend. Sem o env, comportamento
    # histórico do voice-dictation.
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
    """Caminho do python dentro do venv do plugin (Scripts\\ no Windows)."""
    venv = venv_dir or os.path.join(app_dir(), ".venv")
    if sys.platform == "win32":
        return os.path.join(venv, "Scripts", "python.exe")
    return os.path.join(venv, "bin", "python")


def host_src() -> str:
    """Código-fonte sincronizado/executável no host (spawn do ASR).

    Windows: cópia feita pelo install-tasks.ps1 (%LOCALAPPDATA%).
    Linux: o próprio repo roda via PYTHONPATH — spawn usa o mesmo src.
    """
    if sys.platform == "win32":
        return os.path.join(app_dir(), "src")
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
