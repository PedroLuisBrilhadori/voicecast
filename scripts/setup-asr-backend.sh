#!/usr/bin/env bash
# setup-asr-backend.sh — installs the voicecast ASR backend on the Linux host
# (counterpart of the Windows setup-asr-backend.ps1). Idempotent.
#
# Usage:
#   scripts/setup-asr-backend.sh           # installs/updates (src + venv + deps)
#   scripts/setup-asr-backend.sh --check   # reports state only, does not install
#
# Resulting layout (pattern consumed by src/main/asr-host.ts):
#   ${XDG_DATA_HOME:-~/.local/share}/voicecast/asr-backend/
#     ├── src/voice/...        # vendored code (copy of the asr-backend/ repo)
#     ├── .venv/bin/python     # dedicated venv (uv, python 3.12)
#     └── .deps-hash           # marker: only reinstalls deps when the list changes
#
# CUDA: the pchome RTX 3050 runs faster-whisper via ctranslate2 + nvidia pip
# wheels (cublas/cudnn cu12) — same path as Windows. ctranslate2 >=4.5
# locates the libs from the nvidia packages on its own; --check proves it with
# get_cuda_device_count().
set -euo pipefail

DEST="${XDG_DATA_HOME:-$HOME/.local/share}/voicecast/asr-backend"
REPO="$(cd "$(dirname "$0")/.." && pwd)/asr-backend"
# Mirror of the setup-asr-backend.ps1 list (hash is independent per host)
DEPS="faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 fastapi uvicorn python-multipart pydantic numpy"
PY="$DEST/.venv/bin/python"

die() { echo "ERROR: $*" >&2; exit 1; }
passo() { echo "[$1] $2"; }

deps_hash() { printf '%s' "$DEPS" | sha256sum | cut -d' ' -f1; }

estado() {
  local src=no venv=no pyver="-" cuda="-" hash="-"
  [ -f "$DEST/src/voice/asr_service.py" ] && src=yes
  if [ -x "$PY" ]; then
    venv=yes
    pyver="$("$PY" --version 2>&1 | awk '{print $2}')"
    cuda="$("$PY" -c 'import ctranslate2; print(ctranslate2.get_cuda_device_count())' 2>/dev/null || echo error)"
  fi
  [ -f "$DEST/.deps-hash" ] && hash="$(cat "$DEST/.deps-hash" | cut -c1-8)"
  cat <<EOF
src:    $src ($DEST/src/voice/asr_service.py)
venv:   $venv (python $pyver)
cuda:   CUDA devices visible to ctranslate2 = $cuda
deps:   hash $hash (expected $(deps_hash | cut -c1-8))
EOF
}

if [ "${1:-}" = "--check" ]; then
  echo "== ASR backend state (read-only) =="
  estado
  exit 0
fi

echo "PLAN:"
echo "  [1/4] sync vendored code  $REPO → $DEST/src"
echo "  [2/4] create venv (uv, python 3.12)    $DEST/.venv"
echo "  [3/4] install deps                     $DEPS"
echo "  [4/4] validate                         import + CUDA count"
command -v uv >/dev/null || die "uv missing — install it (Arch uv package)"
[ -f "$REPO/voice/asr_service.py" ] || die "repo not found: $REPO"

passo "1/4" "syncing src"
mkdir -p "$DEST"
rm -rf "$DEST/src"
mkdir -p "$DEST/src"
cp -a "$REPO/." "$DEST/src/"
rm -rf "$DEST/src/.venv" "$DEST/src/.deps-hash"

passo "2/4" "creating venv"
if [ ! -x "$PY" ]; then
  uv venv "$DEST/.venv" --python 3.12
fi

passo "3/4" "installing deps (if hash changed)"
MARKER="$DEST/.deps-hash"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$(deps_hash)" ]; then
  # shellcheck disable=SC2086
  uv pip install --python "$PY" $DEPS
  printf '%s' "$(deps_hash)" > "$MARKER"
else
  echo "  deps unchanged — skipping"
fi

passo "4/4" "validating"
"$PY" -c 'import faster_whisper, ctranslate2, fastapi, uvicorn; print("imports ok")'
echo "  CUDA devices: $("$PY" -c 'import ctranslate2; print(ctranslate2.get_cuda_device_count())')"
estado
echo "DONE: the app (src/main/asr-host.ts) finds this layout on its own at next boot."
