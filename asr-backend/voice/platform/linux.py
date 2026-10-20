"""Backend Linux (Wayland/Hyprland) — evdev + wl-clipboard/wtype.

Paridade com o backend win32:
  - hotkey: polling de /dev/input/event* (equivalente ao GetAsyncKeyState) —
    requer o usuário no grupo `input` (ver runbook/recomendacoes do note);
  - colagem: `wl-copy` (permanece residente — Popen, nunca run()) +
    `wtype -k ctrl+v`; fallback unicode = `wtype "<texto>"` (UTF-8 direto,
    independente de layout);
  - beep: seno sintetizado tocado via sounddevice (sem kernel32.Beep);
  - foco: Wayland entrega as teclas à janela focada — foreground_hwnd é no-op;
  - painel: browser em modo app (chromium/firefox) ou xdg-open; resize no-op
    (windowrule do Hyprland cobre se necessário).
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

# Modificadores rastreados p/ o combo Shift+F9 (abrir painel sem gravar)
KEY_LEFTSHIFT = 42
KEY_RIGHTSHIFT = 54
_SHIFT_CODES = {KEY_LEFTSHIFT, KEY_RIGHTSHIFT}


def _keycode_from_vk(vk: int) -> int:
    """VKCode -> código evdev. Só F1..F12 mapeados; override por env."""
    env = os.environ.get("VOICE_HOTKEY_KEYCODE", "").strip()
    if env.isdigit():
        return int(env)
    if vk in VK_TO_EVDEV_FKEYS:
        return VK_TO_EVDEV_FKEYS[vk]
    return 67  # KEY_F9 (default do plugin)


class _EvdevHotkey:
    """Rastreia estado da tecla de ditado lendo /dev/input/event* diretamente.

    Uma thread única varre todos os dispositivos em modo non-blocking; eventos
    EV_KEY com o código alvo atualizam `_down`. Sem permissão (grupo input),
    avisa uma vez e tenta rescan periódico.
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
        """Estado global do Shift — eventos evdev chegam na ordem física,
        então um Shift apertado antes do F9 já está setado quando o poll
        (~12ms) lê os dois estados juntos."""
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
                # re-scan periódico incondicional: adota teclados que nasceram
                # depois do boot (hotplug USB/BT, uinput de sessão remota —
                # RustDesk recria os dispositivos a cada conexão)
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
                    # dispositivo sumiu (BT/USB): fecha SÓ ele e segue;
                    # o re-scan periódico devolve quem renascer
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
        """Sincroniza os fds abertos com /dev/input/event* existentes.

        Sem isso, um teclado criado depois do primeiro scan (dongle USB/BT
        plugado, uinput de sessão remota) nunca é monitorado — o F9 chega ao
        kernel mas o daemon não lê.
        """
        current = set(glob.glob("/dev/input/event*"))
        # dispositivos que sumiram (unplug / fim de sessão remota)
        for fd in [f for f, p in fds.items() if p not in current]:
            try:
                os.close(fd)
            except OSError:
                pass
            del fds[fd]
        # dispositivos novos (hotplug)
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
                "hotkey evdev: +%d dispositivo(s) adotado(s) (hotplug), total=%d",
                added, len(fds),
            )
        if not fds and denied and not self._warned_no_perm:
            self._warned_no_perm = True
            log.error(
                "sem permissao para ler /dev/input/event* (%d dispositivos negados) — "
                "adicione o usuario ao grupo input: sudo usermod -aG input %s "
                "(relogin necessario). Hotkey NAO funciona até lá.",
                denied, os.environ.get("USER", "?"),
            )
        elif fds and not self._logged_total:
            # primeira varredura bem-sucedida loga o total; adoções
            # posteriores têm log próprio (evita spam a cada 5s)
            self._logged_total = True
            log.info(
                "hotkey evdev: %d dispositivo(s) monitorado(s), keycode=%d",
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
        from voice.config import VoiceConfig  # hotkey configurável (hotkey_vk)

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
    """Beep sintetizado tocado via pw-play (cliente PipeWire).

    NÃO usar sounddevice/PortAudio aqui: portaudio do sistema é só-ALSA e,
    ao abrir o device default, pode segurar o PCM hw (pcmC0D0p) com mmap
    mesmo após o fim do stream — bloqueia o PipeWire e o sistema fica mudo
    (sink cai no dummy "Saída de falsa"). pw-play é cliente do PipeWire:
    nunca abre /dev/snd direto, então não existe risco de bloqueio.
    """
    try:
        import io
        import shutil
        import subprocess
        import wave as wavmod
        from pathlib import Path

        player = shutil.which("pw-play") or shutil.which("paplay")
        if not player:
            log.warning("beep ignorado: sem pw-play/paplay no PATH")
            return

        sr = 44100
        n = max(int(sr * ms / 1000), 32)
        t = np.arange(n, dtype=np.float32) / sr
        wave = np.sin(2 * np.pi * freq * t).astype(np.float32) * 0.3
        edge = min(n // 4, int(sr * 0.005)) or 1
        wave[:edge] *= np.linspace(0, 1, edge, dtype=np.float32)
        wave[-edge:] *= np.linspace(1, 0, edge, dtype=np.float32)

        # cache em /tmpfs: gera o wav 1x por boot por (freq, ms); evita
        # re-sintetizar a cada F9 e dispensa limpeza (some no reboot)
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

        # fire-and-forget destacado do daemon (não herda fds nem morre junto)
        subprocess.Popen(
            [player, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        log.exception("beep falhou (ignorado)")


# ── Foco / janela alvo ────────────────────────────────────────────
def foreground_hwnd() -> int:
    """No-op no Wayland: a janela focada recebe as teclas naturalmente."""
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
        return True  # processo existe, mas é de outro usuário
    except OSError:
        return False


# ── Colagem ───────────────────────────────────────────────────────
def _have(bin_name: str) -> bool:
    return shutil.which(bin_name) is not None


def set_clipboard(text: str) -> bool:
    """wl-copy PERMANECE residente para servir pastes futuros — Popen sem wait."""
    if not _have("wl-copy"):
        log.warning("wl-copy não encontrado (pacote wl-clipboard)")
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
        log.exception("wl-copy falhou")
        return False


def _wtype(args: list[str]) -> bool:
    if not _have("wtype"):
        log.warning(
            "wtype não encontrado (pacote community/wtype) — colagem indisponível"
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
        log.exception("wtype falhou")
        return False


# KWin (KDE) não implementa o protocolo de teclado virtual do wtype — o
# fallback é o ydotool (uinput, via ydotoold do usuário; unit ydotool.service)
_YDOTOOL_SOCKET = os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/run/user/1000"), ".ydotool_socket"
)


def _ydotool(args: list[str]) -> bool:
    if not _have("ydotool"):
        log.info("ydotool ausente no PATH")
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
        log.exception("ydotool falhou")
        return False


def _foco_ativo() -> str:
    """Nome da janela ativa X11/XWayland — diagnóstico da colagem (foco vazio
    = foco em janela Wayland nativa, invisível pro xprop)."""
    try:
        out = subprocess.run(
            ["xprop", "-root", "_NET_ACTIVE_WINDOW"],
            capture_output=True, timeout=2,
        )
        win = out.stdout.decode(errors="replace").split("=")[-1].strip()
    except Exception as exc:
        return f"(xprop indisponível: {exc})"
    if win in ("0x0", ""):
        return "nenhuma (foco em janela Wayland nativa ou tela de bloqueio)"
    try:
        nome = subprocess.run(
            ["xdotool", "getwindowname", win],
            capture_output=True, timeout=2,
        )
        return f"{win} «{nome.stdout.decode(errors='replace').strip()}»"
    except Exception:
        return win


def _paste_ctrl_v() -> bool:
    log.info("colagem: foco ativo: %s", _foco_ativo())
    if _wtype(["-M", "Ctrl", "-k", "v", "-m", "Ctrl"]):
        return True
    # evdev: 29=LeftCtrl, 47=KEY_V (25 é KEY_P — "Ctrl+V" com 25 apertava
    # Ctrl+P e o paste nunca chegava; erro vindo da migração para o ydotool)
    ok = _ydotool(["key", "29:1", "47:1", "47:0", "29:0"])
    log.info("colagem: ydotool ctrl+v ok=%s", ok)
    return ok


def _clipboard_registrado(text: str, timeout_s: float = 0.6) -> bool:
    """Espera o wl-copy aparecer como fonte do clipboard (poll com wl-paste).

    O Ctrl+V só cola o que o compositor já registrou: se a injeção vence o
    registro, o alvo recebe o clipboard ANTIGO (ou nada) — e o paste manual
    posterior do usuário funciona, pois aí a fonte já está no ar. Retorna
    False por timeout (o chamador decide: injeta assim mesmo, fail-soft).
    """
    if not _have("wl-paste"):
        log.warning("wl-paste não encontrado — sem verificação de registro")
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
                log.info("clipboard registrado após %.0fms (%d polls)",
                         (timeout_s - (deadline - time.monotonic())) * 1000, attempt)
                return True
        except Exception:
            pass
        attempt += 1
        time.sleep(delay)
        delay = min(delay * 1.6, 0.08)
    log.warning("clipboard não confirmou registro em %.0fs (%d polls) — injetando assim mesmo", timeout_s, attempt)
    return False


def _paste_clipboard(text: str) -> str:
    if not set_clipboard(text):
        return "clipboard-set-falhou"
    # espera o registro real da fonte no compositor antes do Ctrl+V (o sleep
    # fixo de 50ms perdia a corrida e o alvo colava clipboard velho/vazio)
    _clipboard_registrado(text)
    if not _paste_ctrl_v():
        return "ctrl-v-bloqueado"
    return "clipboard"


def _paste_unicode(text: str) -> str:
    if _wtype([text]):
        return "unicode"
    return "unicode" if _ydotool(["type", "--", text]) else "unicode-falhou"


def paste_into_focused(text: str, mode: str, target_hwnd: int) -> str:
    """Insere na janela focada. Mesma semântica do win32: UMA inserção por
    ditado — clipboard→unicode apenas se a etapa anterior falhou de fato."""
    if mode == "unicode":
        return _paste_unicode(text)

    used = _paste_clipboard(text)
    if used == "clipboard":
        return used
    log.warning("clipboard %s - fallback unicode", used)
    return _paste_unicode(text)


# ── Overlay do painel ─────────────────────────────────────────────
PANEL_TITLE = "Dictação por Voz"

# Janela recém-aberta ainda não casa no match por título (o chromium só seta
# o título da página depois de carregar; antes disso é initialTitle=URL) —
# cooldown evita abrir uma SEGUNDA janela nesse vácuo.
_PANEL_SPAWN_COOLDOWN_S = 5.0
_panel_spawn_lock = threading.Lock()
_panel_spawn_at = 0.0  # time.monotonic() do último spawn (0 = nunca spawnou)


def _hypr_sigs() -> list[str]:
    """Assinaturas de instância do Hyprland para tentar, mais recente primeiro.

    O serviço pode subir antes de o autostart importar
    HYPRLAND_INSTANCE_SIGNATURE ao systemd user — ou sobreviver a um restart
    do Hyprland, que troca a assinatura. Nesses estados o `hyprctl` puro
    falha ("HYPRLAND_INSTANCE_SIGNATURE not set!" / socket morto) e o painel
    virava uma janela nova a cada F9. As instâncias vivas são descobertas
    pelos sockets em $XDG_RUNTIME_DIR/hypr/<sig>/.socket.sock.
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
    """roda `hyprctl -i <sig> ...`; stdout (str) se ok, None se falhou."""
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
    """Foca a janela <addr> na instância <sig>; sucesso só com resposta 'ok'.

    Hyprland >= 0.56 (lua IPC) rejeita o request clássico
    `dispatch focuswindow address:X` com erro de sintaxe Lua — a forma nova é
    `eval hl.dispatch(hl.dsp.focus({window='address:X'}))`. Tentamos a nova
    primeiro e caímos para a clássica (instâncias pré-0.56). Respostas
    "warning:" (janela sumiu entre o clients e o foco) não valem sucesso.
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
    """Foca a janela do painel se já existir (Hyprland IPC). True se achou.

    Sem isso, cada gravação abria OUTRA janela do browser em modo app.
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
            "painel: IPC do Hyprland inacessível — foco de janela existente "
            "falhou (sigs tentadas: %s)", _hypr_sigs() or "nenhuma",
        )
    return False


def show_panel_window(expanded: bool = False) -> None:
    """Foca a janela do painel existente; abre em modo app só se não houver."""
    # largura acoplada a: web/src/App.tsx (resizeWindow) e platform/win32.py
    w, h = (
        (860, 880) if expanded else (860, 400)
    )
    global _panel_spawn_at
    with _panel_spawn_lock:
        if _focus_existing_panel():
            _panel_spawn_at = 0.0
            return
        if time.monotonic() - _panel_spawn_at < _PANEL_SPAWN_COOLDOWN_S:
            log.info("painel: janela recente em abertura — spawn em cooldown")
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
        log.warning("nenhum browser para abrir o painel %s (ignorado)", PANEL_URL)


def resize_panel_window(width: int, height: int) -> None:
    """No-op no Linux — fixe tamanho/posição com windowrule do Hyprland."""


# ── Spawn do ASR ──────────────────────────────────────────────────
def asr_command() -> list[str] | None:
    exe = venv_python()
    if not os.path.exists(exe):
        log.error("venv não encontrado para spawn do ASR: %s", exe)
        return None
    return [exe, "-m", "voice.asr_service", "--port", "8701"]


def popen_kwargs() -> dict:
    return {"start_new_session": True}
