#!/usr/bin/env bash
# setup-asr-backend.sh — instala o backend ASR do voicecast no host Linux
# (par do setup-asr-backend.ps1 Windows). Idempotente.
#
# Uso:
#   scripts/setup-asr-backend.sh           # instala/atualiza (src + venv + deps)
#   scripts/setup-asr-backend.sh --check   # só reporta o estado, não instala
#
# Layout resultante (padrão consumido por src/main/asr-host.ts):
#   ${XDG_DATA_HOME:-~/.local/share}/voicecast/asr-backend/
#     ├── src/voice/...        # código vendorizado (cópia do repo asr-backend/)
#     ├── .venv/bin/python     # venv próprio (uv, python 3.12)
#     └── .deps-hash           # marcador: só reinstala deps quando a lista muda
#
# CUDA: a RTX 3050 do pchome roda faster-whisper via ctranslate2 + wheels
# nvidia pip (cublas/cudnn cu12) — mesmo caminho do Windows. ctranslate2 >=4.5
# localiza as libs dos pacotes nvidia sozinho; o --check prova com
# get_cuda_device_count().
set -euo pipefail

DEST="${XDG_DATA_HOME:-$HOME/.local/share}/voicecast/asr-backend"
REPO="$(cd "$(dirname "$0")/.." && pwd)/asr-backend"
# Espelho da lista do setup-asr-backend.ps1 (hash independente por host)
DEPS="faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 fastapi uvicorn python-multipart pydantic numpy"
PY="$DEST/.venv/bin/python"

die() { echo "ERRO: $*" >&2; exit 1; }
passo() { echo "[$1] $2"; }

deps_hash() { printf '%s' "$DEPS" | sha256sum | cut -d' ' -f1; }

estado() {
  local src=nao venv=nao pyver="-" cuda="-" hash="-"
  [ -f "$DEST/src/voice/asr_service.py" ] && src=sim
  if [ -x "$PY" ]; then
    venv=sim
    pyver="$("$PY" --version 2>&1 | awk '{print $2}')"
    cuda="$("$PY" -c 'import ctranslate2; print(ctranslate2.get_cuda_device_count())' 2>/dev/null || echo erro)"
  fi
  [ -f "$DEST/.deps-hash" ] && hash="$(cat "$DEST/.deps-hash" | cut -c1-8)"
  cat <<EOF
src:    $src ($DEST/src/voice/asr_service.py)
venv:   $venv (python $pyver)
cuda:   dispositivos CUDA visíveis ao ctranslate2 = $cuda
deps:   hash $hash (esperado $(deps_hash | cut -c1-8))
EOF
}

if [ "${1:-}" = "--check" ]; then
  echo "== estado do backend ASR (read-only) =="
  estado
  exit 0
fi

echo "PLANO:"
echo "  [1/4] sincronizar código vendorizado  $REPO → $DEST/src"
echo "  [2/4] criar venv (uv, python 3.12)    $DEST/.venv"
echo "  [3/4] instalar deps                   $DEPS"
echo "  [4/4] validar                         import + CUDA count"
command -v uv >/dev/null || die "uv ausente — instale (pacote uv do Arch)"
[ -f "$REPO/voice/asr_service.py" ] || die "repo não encontrado: $REPO"

passo "1/4" "sincronizando src"
mkdir -p "$DEST"
rm -rf "$DEST/src"
mkdir -p "$DEST/src"
cp -a "$REPO/." "$DEST/src/"
rm -rf "$DEST/src/.venv" "$DEST/src/.deps-hash"

passo "2/4" "criando venv"
if [ ! -x "$PY" ]; then
  uv venv "$DEST/.venv" --python 3.12
fi

passo "3/4" "instalando deps (se hash mudou)"
MARKER="$DEST/.deps-hash"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$(deps_hash)" ]; then
  # shellcheck disable=SC2086
  uv pip install --python "$PY" $DEPS
  printf '%s' "$(deps_hash)" > "$MARKER"
else
  echo "  deps inalteradas — pulando"
fi

passo "4/4" "validando"
"$PY" -c 'import faster_whisper, ctranslate2, fastapi, uvicorn; print("imports ok")'
echo "  CUDA devices: $("$PY" -c 'import ctranslate2; print(ctranslate2.get_cuda_device_count())')"
estado
echo "PRONTO: o app (src/main/asr-host.ts) encontra este layout sozinho no próximo boot."
