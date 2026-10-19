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

# ozone-hint: Wayland nativo no KDE; GlobalShortcutsPortal: Ctrl+F9 etc. via
# portal xdg-desktop-portal-kde (globalShortcut não existe em Wayland sem ele)
exec "$ELECTRON" . \
  --ozone-platform-hint=auto \
  --enable-features=GlobalShortcutsPortal \
  "$@"
