#!/usr/bin/env bash
# kde-toggle.sh — gancho p/ atalhos customizados do KDE (kcm_keys → Comando).
# A 2ª instância sinaliza a viva via single-instance e sai (~1s).
# Uso: kde-toggle.sh [ditado|rec|painel]
set -euo pipefail
ACAO="${1:-painel}"
exec /home/pedro/programing/projetos/voicecast/scripts/run-linux.sh "--$ACAO"
