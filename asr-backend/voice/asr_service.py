"""Local ASR/TTS service — fastapi + faster-whisper on the RTX 3050.

Endpoints:
  POST /v1/transcribe  multipart audio (file) + ?model= -> {text, language, segments}
  POST /v1/tts         {"text": "..."}                  -> wav (System.Speech on
                                                          Windows; espeak-ng pt-BR on Linux)
  GET  /health                                          -> {status, model, cuda}

Usage:
  voice-asr                 # uvicorn on 127.0.0.1:8701
  voice-asr --port 8702

The port opens BEFORE the model loads (background thread + MODEL_READY
event): the daemon/health-check sees the service up during the model load
(~1.5GB) and does not spawn a duplicate process. /v1/transcribe waits for
the model to be ready (timeout 180s) or replies 503.

Telemetry: OTLP-HTTP to the local collector (see voice/telemetry.py) —
FastAPI traces, model load and transcription duration, logs -> Loki.
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
def _tem_cuda() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


DEVICE = os.environ.get("VOICE_ASR_DEVICE", "cuda" if _tem_cuda() else "cpu")
COMPUTE_TYPE = os.environ.get(
    "VOICE_ASR_COMPUTE", "float16" if DEVICE == "cuda" else "int8"
)
LANGUAGE = os.environ.get("VOICE_ASR_LANGUAGE", "pt")
# CPU threads for ctranslate2 (only used when device=cpu; 0 = lib default)
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
    "voice_asr_model_load_seconds", unit="s", description="model load duration"
)
_METRIC_TRANSCRIBE = _METER.create_histogram(
    "voice_asr_transcribe_seconds", unit="s", description="transcription duration"
)
_METRIC_REJECTS = _METER.create_counter(
    "voice_asr_transcribe_rejected_total",
    description="transcriptions rejected (model loading)",
)
_TRACER = telemetry.tracer("asr")

# ── persisted load-time history per model (for the loading progress) ──
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
        # smooth EMA: the average of recent loads outweighs an outlier
        m[model] = round(seconds * 0.4 + prev * 0.6, 2) if prev else round(seconds, 2)
        os.makedirs(APP_DIR, exist_ok=True)
        with open(_LOAD_FILE, "w", encoding="utf-8") as f:
            json.dump(m, f)
    except Exception:
        pass



# ── inference duration estimate (for an honest progress) ──
# EMA of "inference seconds per audio second" per model;
# heuristic fallback until each model's first real calibration.
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
            log.info("model '%s' loaded (%.1fs)", name, time.monotonic() - started)
    return _model


def _preload_default() -> None:
    try:
        get_model(MODEL_DEFAULT)
    except Exception:
        log.exception("model preload failed")
    finally:
        MODEL_READY.set()


def _wait_model(model_name: str) -> None:
    if model_name == MODEL_DEFAULT and not MODEL_READY.wait(timeout=MODEL_WAIT_S):
        _METRIC_REJECTS.add(1, {"model": model_name, "reason": "carregando"})
        telemetry.log_event(log, "transcribe.reject", model=model_name, reason="carregando")
        raise HTTPException(status_code=503, detail="model loading")


def _normalize(audio: np.ndarray) -> np.ndarray:
    """Peak-normalize to ~-1dBFS. Whisper performs better with audio at a proper level
    (the mic usually records at ~-60dB, which degrades transcription)."""
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio = audio / peak * 0.89
    return audio.astype(np.float32)


class TTSRequest(BaseModel):
    text: str
    voice: str = "Microsoft Maria Desktop"


def _tts_windows(text: str, voice: str) -> bytes:
    """Synthesizes on Windows (System.Speech) via powershell.exe and returns wav."""
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
        raise RuntimeError(f"TTS PowerShell failed: {proc.stderr[:500]}")
    b64 = proc.stdout.strip().splitlines()[-1].strip()
    return __import__("base64").b64decode(b64)


def _tts_linux(text: str, voice: str) -> bytes:
    """Synthesizes via espeak-ng pt-BR and returns wav.

    The `voice` field of the request is ignored on Linux (espeak-ng uses the
    system pt-br voice). Higher quality: Piper (future improvement, see README).
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
            raise RuntimeError(f"TTS espeak-ng failed: {proc.stderr[:500]}")
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
    """Loading state of a model (for the panel's loading bar)."""
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
        "model": _model_name if ready else f"{MODEL_DEFAULT} (loading)",
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


def _prepare_transcribe(file: UploadFile, model: str) -> tuple:
    """Validates model/audio common to the transcription endpoints.

    Returns (whisper, audio_normalized). Raises a clear 503 if the model
    fails to load (e.g. HF_HUB_OFFLINE=1 and never downloaded).
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
        # most common cause: HF_HUB_OFFLINE=1 and model never downloaded
        _METRIC_REJECTS.add(1, {"model": model, "reason": "offline"})
        telemetry.log_event(log, "transcribe.reject", model=model, reason="offline")
        log.exception("failed to load model '%s'", model)
        raise HTTPException(
            status_code=503,
            detail=(
                f"model '{model}' unavailable in the local cache "
                f"(service runs offline). Download it once while online: "
                f"HF_HUB_OFFLINE=0 python -c \"from faster_whisper import "
                f"WhisperModel; WhisperModel('{model}', device='{DEVICE}')\""
            ),
        ) from e
    return whisper, audio


def _normalize_language(language: str | None) -> str | None:
    """"" or "auto" → None (whisper auto-detection). External integrators
    (e.g. uniscraper transcribing videos) ask for auto; dictation stays pt."""
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
    """NDJSON variant of /v1/transcribe with incremental progress.

    Lines emitted: {"type":"start","duration_s":s,"model":m} →
    {"type":"seg","end":t,"text":...} per segment →
    {"type":"done", ...final result} (same schema as the synchronous endpoint).
    Errors: {"type":"error","detail":...}.
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
                _METRIC_TRANSCRIBE.record(0.0, {"model": model})  # cheap heartbeat
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
        # vad=False (voice-11): re-transcription of drafts whose speech the VAD
        # discarded for being too quiet (e.g. the audio hub's virtual mic)
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
        # average confidence (avg_logprob; ~0 = great, < -0.6 = suspicious) —
        # used by dataset/validation to flag dubious samples
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
        log.warning(" could not write pidfile %s", PID_FILE, exc_info=True)


def _remove_pidfile() -> None:
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Local ASR/TTS service")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    _write_pidfile()
    atexit.register(_remove_pidfile)
    try:
        log.info(
            "asr service starting (model=%s device=%s/%s)", MODEL_DEFAULT, DEVICE, COMPUTE_TYPE
        )
        # port opens BEFORE the load — health replies 'loading' and the daemon doesn't duplicate
        threading.Thread(target=_preload_default, daemon=True).start()
        uvicorn.run(app, host=args.host, port=args.port)
    finally:
        _remove_pidfile()


if __name__ == "__main__":
    main()
