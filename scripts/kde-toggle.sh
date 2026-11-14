#!/usr/bin/env bash
# kde-toggle.sh — hook for custom KDE shortcuts (kcm_keys → Command).
# The 2nd instance signals the live one via single-instance and exits (~1s).
# Usage: kde-toggle.sh [ditado|rec|painel]
set -euo pipefail
ACAO="${1:-painel}"
exec /home/pedro/programing/projetos/voicecast/scripts/run-linux.sh "--$ACAO"
