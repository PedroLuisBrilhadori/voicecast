#!/usr/bin/env bash
# run-linux.sh — roda o voicecast nativo no Arch (Wayland/KDE), par do run-win.ps1.
# Uso: scripts/run-linux.sh [--ditado-test|--autotest|--transcribe=DIR/NOME ...]
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON="node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "ERRO: electron sem binário — rode: pnpm install --ignore-workspace && (cd node_modules/electron && node install.js)" >&2
  exit 2
fi
if [ ! -f dist/main/index.js ]; then
  echo "ERRO: sem build — rode: pnpm build" >&2
  exit 2
fi

# GlobalShortcut no KDE Wayland: o portal precisa de binding manual no KCM
# (o app registra, o KWin não amarra sozinho) — sob XWayland o XGrabKey
# funciona como no Windows, determinístico. VOICECAST_OZONE=wayland para o
# modo nativo (atalhos viram config manual no kcm_keys).
OZONE="${VOICECAST_OZONE:-x11}"
exec "$ELECTRON" . \
  --ozone-platform="$OZONE" \
  --enable-features=GlobalShortcutsPortal \
  "$@"
