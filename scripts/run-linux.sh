#!/usr/bin/env bash
# run-linux.sh — runs voicecast natively on Arch (Wayland/KDE), counterpart of run-win.ps1.
# Usage: scripts/run-linux.sh [--ditado-test|--autotest|--transcribe=DIR/NOME ...]
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON="node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "ERROR: electron has no binary — run: pnpm install --ignore-workspace && (cd node_modules/electron && node install.js)" >&2
  exit 2
fi
if [ ! -f dist/main/index.js ]; then
  echo "ERROR: no build — run: pnpm build" >&2
  exit 2
fi

# GlobalShortcut on KDE Wayland: the portal needs a manual binding in the KCM
# (the app registers it, KWin doesn't bind on its own) — under XWayland XGrabKey
# works as on Windows, deterministic. VOICECAST_OZONE=wayland for native
# mode (shortcuts become manual config in kcm_keys).
OZONE="${VOICECAST_OZONE:-x11}"
exec "$ELECTRON" . \
  --ozone-platform="$OZONE" \
  --enable-features=GlobalShortcutsPortal \
  "$@"
