"""ASR/TTS service local — fastapi + faster-whisper na RTX 3050.

Endpoints:
  POST /v1/transcribe  multipart áudio (file) + ?model= -> {text, language, segments}
  POST /v1/tts         {"text": "..."}                  -> wav (System.Speech no
                                                          Windows; espeak-ng pt-BR no Linux)
  GET  /health                                          -> {status, model, cuda}

Uso:
  voice-asr                 # uvicorn em 127.0.0.1:8701
  voice-asr --port 8702

A porta abre ANTES do modelo carregar (thread de background + evento
MODEL_READY): o daemon/health-check enxerga o serviço de pé durante o load do
modelo (~1.5GB) e não spawna um processo duplicado. /v1/transcribe espera o
modelo ficar pronto (timeout 180s) ou responde 503.

Telemetria: OTLP-HTTP para o collector local (ver voice/telemetry.py) —
traces do FastAPI, duração de load do modelo e de transcrição, logs -> Loki.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np
import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from faster_whisper import WhisperModel
from pydantic import BaseModel

from voice import telemetry
from voice.platform.common import app_dir

APP_DIR = app_dir()
LOG_FILE = os.path.join(APP_DIR, "asr.log")
PID_FILE = os.path.join(APP_DIR, "asr.pid")
os.makedirs(APP_DIR, exist_ok=True)

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("voice-asr")

telemetry.init_telemetry("voice-asr")

try:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    _HAS_FASTAPI_OTELO = True
except Exception:
    _HAS_FASTAPI_OTELO = False

MODEL_DEFAULT = os.environ.get("VOICE_ASR_MODEL", "large-v3-turbo")
HOST = os.environ.get("VOICE_ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_ASR_PORT", "8701"))
DEVICE = os.environ.get("VOICE_ASR_DEVICE", "cuda" if sys.platform == "win32" else "cpu")
COMPUTE_TYPE = os.environ.get(
    "VOICE_ASR_COMPUTE", "float16" if sys.platform == "win32" else "int8"
)
LANGUAGE = os.environ.get("VOICE_ASR_LANGUAGE", "pt")
# threads de CPU para ctranslate2 (só usado quando device=cpu; 0 = default do lib)
CPU_THREADS = int(os.environ.get("VOICE_ASR_CPU_THREADS", "0"))
INITIAL_PROMPT = os.environ.get(
    "VOICE_ASR_INITIAL_PROMPT",
    "Este é um ditado por voz em português brasileiro. "
    "Transcreva exatamente o que foi falado, com pontuação natural.",
)
MODEL_WAIT_S = float(os.environ.get("VOICE_ASR_MODEL_WAIT_S", "180"))

app = FastAPI(title="voice-dictation ASR", version="0.3.0")

if _HAS_FASTAPI_OTELO:
    FastAPIInstrumentor.instrument_app(app)

_model: WhisperModel | None = None
_model_name: str = MODEL_DEFAULT
_model_lock = threading.Lock()
MODEL_READY = threading.Event()

_METER = telemetry.meter()
_METRIC_LOAD = _METER.create_histogram(
    "voice_asr_model_load_seconds", unit="s", description="duração do load do modelo"
)
_METRIC_TRANSCRIBE = _METER.create_histogram(
    "voice_asr_transcribe_seconds", unit="s", description="duração da transcrição"
)
_METRIC_REJECTS = _METER.create_counter(
    "voice_asr_transcribe_rejected_total",
    description="transcrições recusadas (modelo carregando)",
)
_TRACER = telemetry.tracer("asr")

# ── histórico persistido de tempo de load por modelo (p/ progresso do loading) ──
_LOAD_FILE = os.path.join(APP_DIR, "model_loads.json")
_DEFAULT_LOAD_S = {"base": 2.0, "small": 3.5, "medium": 9.0, "large-v3-turbo": 22.0}


def _load_map() -> dict:
    try:
        with open(_LOAD_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _expected_load_s(model: str) -> float:
    return float(_load_map().get(model) or _DEFAULT_LOAD_S.get(model, 6.0))


def _remember_load(model: str, seconds: float) -> None:
    try:
        m = _load_map()
        prev = m.get(model)
        # EMA suave: média dos últimos loads pesa mais que um outlier
        m[model] = round(seconds * 0.4 + prev * 0.6, 2) if prev else round(seconds, 2)
        os.makedirs(APP_DIR, exist_ok=True)
        with open(_LOAD_FILE, "w", encoding="utf-8") as f:
            json.dump(m, f)
    except Exception:
        pass



# ── estimativa de duração de inferência (p/ progresso honesto) ──
# EMA de "segundos de inferência por segundo de áudio" por modelo;
# fallback heurístico até a primeira calibração real de cada um.
_RATE_EMA: dict[str, float] = {}
_DEFAULT_RATE = {"base": 0.12, "small": 0.35, "medium": 1.1, "large-v3-turbo": 1.9}


def _expected_inference_s(model: str, audio_s: float) -> float:
    rate = _RATE_EMA.get(model) or _DEFAULT_RATE.get(model, 2.0)
    return max(0.05, rate * audio_s)


def _calibrate_rate(model: str, audio_s: float, inference_s: float) -> None:
    if audio_s <= 0:
        return
    rate = inference_s / audio_s
    prev = _RATE_EMA.get(model)
    _RATE_EMA[model] = round(rate * 0.3 + prev * 0.7, 4) if prev else round(rate, 4)



def get_model(name: str) -> WhisperModel:
    global _model, _model_name
    with _model_lock:
        if _model is None or _model_name != name:
            started = time.monotonic()
            if _model is not None:
                del _model
            kwargs: dict = {"device": DEVICE, "compute_type": COMPUTE_TYPE}
            if CPU_THREADS > 0 and DEVICE == "cpu":
                kwargs["cpu_threads"] = CPU_THREADS
            _model = WhisperModel(name, **kwargs)
            _model_name = name
            load_s = time.monotonic() - started
            _METRIC_LOAD.record(load_s, {"model": name})
            _remember_load(name, load_s)
            log.info("modelo '%s' carregado (%.1fs)", name, time.monotonic() - started)
    return _model


def _preload_default() -> None:
    try:
        get_model(MODEL_DEFAULT)
    except Exception:
        log.exception("preload do modelo falhou")
    finally:
        MODEL_READY.set()


def _wait_model(model_name: str) -> None:
    if model_name == MODEL_DEFAULT and not MODEL_READY.wait(timeout=MODEL_WAIT_S):
        _METRIC_REJECTS.add(1, {"model": model_name, "reason": "carregando"})
        telemetry.log_event(log, "transcribe.reject", model=model_name, reason="carregando")
        raise HTTPException(status_code=503, detail="modelo carregando")


def _normalize(audio: np.ndarray) -> np.ndarray:
    """Peak-normalize para ~-1dBFS. Whisper rende melhor com áudio em nível adequado
    (o mic costuma captar em ~-60dB, o que degrada a transcrição)."""
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio = audio / peak * 0.89
    return audio.astype(np.float32)


class TTSRequest(BaseModel):
    text: str
    voice: str = "Microsoft Maria Desktop"


def _tts_windows(text: str, voice: str) -> bytes:
    """Sintetiza no Windows (System.Speech) via powershell.exe e devolve wav."""
    ps = r"""
param($text, $voice)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($voice)
$stream = New-Object System.IO.MemoryStream
$synth.SetOutputToWaveStream($stream)
$synth.Speak($text)
$synth.SetOutputToNull()
[Convert]::ToBase64String($stream.ToArray())
"""
    code = (
        "$text = " + repr(text) + "\n"
        "$voice = " + repr(voice) + "\n"
        + ps
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", code],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TTS PowerShell falhou: {proc.stderr[:500]}")
    b64 = proc.stdout.strip().splitlines()[-1].strip()
    return __import__("base64").b64decode(b64)


def _tts_linux(text: str, voice: str) -> bytes:
    """Sintetiza via espeak-ng pt-BR e devolve wav.

    O campo `voice` do request é ignorado no Linux (o espeak-ng usa a voz
    pt-br do sistema). Qualidade superior: Piper (melhoria futura, ver README).
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        proc = subprocess.run(
            ["espeak-ng", "-v", "pt-br", "-w", out_path, text],
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"TTS espeak-ng falhou: {proc.stderr[:500]}")
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


def _tts(text: str, voice: str) -> bytes:
    if sys.platform == "win32":
        return _tts_windows(text, voice)
    return _tts_linux(text, voice)


@app.get("/v1/model-status")
def model_status(model: str = Query(default=MODEL_DEFAULT)) -> dict:
    """Estado de carregamento de um modelo (p/ barra de loading do painel)."""
    loaded = bool(MODEL_READY.is_set() and _model is not None and _model_name == model)
    return {
        "model": model,
        "loaded": loaded,
        "current": _model_name,
        "expected_load_s": _expected_load_s(model),
    }


@app.get("/health")
def health() -> dict:
    ready = MODEL_READY.is_set()
    return {
        "status": "ok" if ready else "loading",
        "model": _model_name if ready else f"{MODEL_DEFAULT} (carregando)",
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


def _prepare_transcribe(file: UploadFile, model: str) -> tuple:
    """Valida modelo/áudio comuns aos endpoints de transcrição.

    Devolve (whisper, audio_normalized). Levanta 503 claro se o modelo não
    carrega (ex.: HF_HUB_OFFLINE=1 e nunca baixado).
    """
    raw = file.file.read()
    data = np.frombuffer(raw, dtype=np.int16)
    if data.size == 0:
        return None, np.zeros(0, dtype=np.float32)
    audio = _normalize(data.astype(np.float32) / 32768.0)

    try:
        whisper = get_model(model)
    except HTTPException:
        raise
    except Exception as e:
        # causa mais comum: HF_HUB_OFFLINE=1 e modelo nunca baixado
        _METRIC_REJECTS.add(1, {"model": model, "reason": "offline"})
        telemetry.log_event(log, "transcribe.reject", model=model, reason="offline")
        log.exception("falha ao carregar modelo '%s'", model)
        raise HTTPException(
            status_code=503,
            detail=(
                f"modelo '{model}' indisponível no cache local "
                f"(serviço roda offline). Baixe uma vez online: "
                f"HF_HUB_OFFLINE=0 python -c \"from faster_whisper import "
                f"WhisperModel; WhisperModel('{model}', device='{DEVICE}')\""
            ),
        ) from e
    return whisper, audio


def _normalize_language(language: str | None) -> str | None:
    """"" ou "auto" → None (auto-detecção do whisper). Integradores externos
    (ex.: uniscraper transcrevendo vídeos) pedem auto; o ditado segue pt."""
    if language in ("", "auto"):
        return None
    return language


@app.post("/v1/transcribe/stream")
def transcribe_stream(
    file: UploadFile = File(...),
    model: str = Query(default=MODEL_DEFAULT),
    language: str | None = Query(default=LANGUAGE),
    initial_prompt: str | None = Query(default=None),
    vad: bool = Query(default=True),
):
    """Variante NDJSON do /v1/transcribe com progresso incremental.

    Linhas emitidas: {"type":"start","duration_s":s,"model":m} →
    {"type":"seg","end":t,"text":...} por segmento →
    {"type":"done", ...resultado final} (mesmo schema do endpoint síncrono).
    Erros: {"type":"error","detail":...}.
    """
    from fastapi.responses import StreamingResponse
    language = _normalize_language(language)

    _wait_model(model)
    whisper, audio = _prepare_transcribe(file, model)
    duration = round(len(audio) / 16000.0, 2)

    def gen():
        expected_s = round(_expected_inference_s(model, duration), 2)
        yield json.dumps({"type": "start", "duration_s": duration, "model": model,
                          "expected_s": expected_s}) + "\n"
        if not audio.size:
            yield json.dumps({"type": "done", "text": "", "language": None,
                              "confidence": None, "model": model,
                              "segments": [], "words": []}) + "\n"
            return
        started = time.monotonic()
        text_parts, logprobs, all_words, segs = [], [], [], []
        try:
            segments, info = whisper.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=vad,
                word_timestamps=True,
                initial_prompt=initial_prompt if initial_prompt is not None else INITIAL_PROMPT,
                condition_on_previous_text=True,
            )
            for s in segments:
                words = [
                    {"w": w.word.strip(), "start": round(w.start, 2),
                     "end": round(w.end, 2), "p": round(w.probability, 3)}
                    for w in (s.words or [])
                ]
                segs.append({"start": round(s.start, 2), "end": round(s.end, 2),
                             "text": s.text.strip(),
                             "avg_logprob": round(s.avg_logprob, 3), "words": words})
                all_words.extend(words)
                text_parts.append(s.text.strip())
                logprobs.append(s.avg_logprob)
                _METRIC_TRANSCRIBE.record(0.0, {"model": model})  # heartbeat barato
                yield json.dumps({"type": "seg", "end": round(s.end, 2),
                                  "text": s.text.strip()}, ensure_ascii=False) + "\n"
            elapsed = time.monotonic() - started
            _calibrate_rate(model, duration, elapsed)
            confidence = round(sum(logprobs) / len(logprobs), 3) if logprobs else None
            result = {
                "text": " ".join(text_parts).strip(),
                "language": info.language,
                "confidence": confidence,
                "model": _model_name,
                "segments": segs,
                "words": all_words,
                "elapsed_s": round(elapsed, 2),
            }
            yield json.dumps({"type": "done", **result}, ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.post("/v1/transcribe")
def transcribe(
    file: UploadFile = File(...),
    model: str = Query(default=MODEL_DEFAULT),
    language: str | None = Query(default=LANGUAGE),
    initial_prompt: str | None = Query(default=None),
    vad: bool = Query(default=True),
) -> dict:
    language = _normalize_language(language)
    _wait_model(model)
    with _TRACER.start_as_current_span("asr.transcribe") as span:
        span.set_attribute("asr.model", model)
        span.set_attribute("asr.device", DEVICE)
        whisper, audio = _prepare_transcribe(file, model)
        if not audio.size:
            return {"text": "", "language": None, "segments": [], "words": [],
                    "model": model}

        started = time.monotonic()
        # vad=False (voice-11): re-transcrição de rascunhos cuja fala o VAD
        # descartou por nível baixo (ex.: mic virtual do hub de áudio)
        segments, info = whisper.transcribe(
            audio,
            language=language,
            beam_size=5,
            vad_filter=vad,
            word_timestamps=True,
            initial_prompt=initial_prompt if initial_prompt is not None else INITIAL_PROMPT,
            condition_on_previous_text=True,
        )
        segs = []
        text_parts = []
        logprobs = []
        all_words = []
        for s in segments:
            words = [
                {
                    "w": w.word.strip(),
                    "start": round(w.start, 2),
                    "end": round(w.end, 2),
                    "p": round(w.probability, 3),
                }
                for w in (s.words or [])
            ]
            segs.append(
                {
                    "start": round(s.start, 2),
                    "end": round(s.end, 2),
                    "text": s.text.strip(),
                    "avg_logprob": round(s.avg_logprob, 3),
                    "words": words,
                }
            )
            all_words.extend(words)
            text_parts.append(s.text.strip())
            logprobs.append(s.avg_logprob)
        elapsed = time.monotonic() - started
        _METRIC_TRANSCRIBE.record(elapsed, {"model": model})
        _calibrate_rate(model, len(audio) / 16000, elapsed)
        telemetry.log_event(
            log, "transcribe.ok", model=model, seconds=round(elapsed, 3),
            chars=len(" ".join(text_parts).strip()),
        )
        span.set_attribute("asr.audio_seconds", round(len(audio) / 16000, 2))
        span.set_attribute("asr.duration_s", round(elapsed, 2))
        # confiança média (avg_logprob; ~0 = ótimo, < -0.6 = suspeito) —
        # usada pelo dataset/validation para marcar amostras duvidosas
        confidence = round(sum(logprobs) / len(logprobs), 3) if logprobs else None
        vad_removed_s = round(
            info.duration - getattr(info, "duration_after_vad", info.duration), 2
        )
        return {
            "text": " ".join(text_parts).strip(),
            "language": info.language,
            "confidence": confidence,
            "model": _model_name,
            "vad_removed_s": vad_removed_s,
            "audio_s": round(len(audio) / 16000, 2),
            "segments": segs,
            "words": all_words,
        }


@app.post("/v1/tts")
def tts(req: TTSRequest) -> dict:
    wav = _tts(req.text, req.voice)
    return {
        "format": "audio/wav",
        "audio_base64": base64.b64encode(wav).decode(),
    }


def _write_pidfile() -> None:
    try:
        import datetime

        with open(PID_FILE, "w", encoding="ascii") as f:
            f.write(f"{os.getpid()}\n{datetime.datetime.now().isoformat()}\n")
    except Exception:
        log.warning(" nao consegui escrever pidfile %s", PID_FILE, exc_info=True)


def _remove_pidfile() -> None:
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Servico ASR/TTS local")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    _write_pidfile()
    atexit.register(_remove_pidfile)
    try:
        log.info(
            "asr service iniciando (modelo=%s device=%s/%s)", MODEL_DEFAULT, DEVICE, COMPUTE_TYPE
        )
        # porta abre ANTES do load — health responde 'loading' e o daemon nao duplica
        threading.Thread(target=_preload_default, daemon=True).start()
        uvicorn.run(app, host=args.host, port=args.port)
    finally:
        _remove_pidfile()


if __name__ == "__main__":
    main()
