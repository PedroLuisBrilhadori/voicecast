# asr-backend — serviço ASR vendorizado

Cópia do serviço de transcrição do `voice` (faster-whisper + FastAPI), original
em `server-docs/workstations/shared/scripts/voice/src/voice/`. O voicecast
**hospeda** este backend: `src/main/asr-host.ts` spawna e supervisiona o
`python -m voice.asr_service --port 8701` a partir da cópia instalada em
`%LOCALAPPDATA%\voicecast\asr-backend` (criada por `scripts/setup-asr-backend.ps1`).

## Subset vendorizado (2026-09-22)

| Arquivo | Motivo |
|---|---|
| `voice/asr_service.py` | O serviço em si (`/health`, `/v1/transcribe`, `/v1/tts`) |
| `voice/telemetry.py` | Importado pelo asr_service (best-effort; rodamos com `OTEL_ENABLED=0`) |
| `voice/platform/{__init__,common,win32,linux}.py` | `get_backend()` — colagem do ditado (`paste_into_focused`) e paths |

Módulos do daemon/painel/dataset NÃO vieram (aposentados — VISAO-V2).

## Divergência vs. server-docs

- `platform/common.py`: `app_dir()` respeita o env `VOICE_APP_DIR` (o host do
  voicecast define a raiz de dados do backend). Sem o env, comportamento
  original é preservado.

## Atualizar a partir do server-docs

```bash
SRC=../server-docs/workstations/shared/scripts/voice/src/voice
cp $SRC/asr_service.py $SRC/telemetry.py voice/
cp $SRC/platform/*.py voice/platform/
# reaplicar o patch do VOICE_APP_DIR em voice/platform/common.py (ver acima)
```

Modelos whisper ficam no cache HF do usuário (`~/.cache/huggingface`) —
compartilhado entre venvs, sem re-download.
