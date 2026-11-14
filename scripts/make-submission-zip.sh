#!/usr/bin/env bash
# make-submission-zip.sh — gera o zip sanitizado do voicecast para submissão
# no Code Behaviors (Taiga/Alignerr).
#
# Uso:
#   scripts/make-submission-zip.sh [-o SAIDA.zip]   gera o zip a partir do HEAD
#   scripts/make-submission-zip.sh --check [ARQUIVO.zip]
#                                                   valida um zip existente
#                                                   (default: /tmp/voicecast-upload.zip)
#
# O que entra:  snapshot do HEAD (git archive), com .gitignore e .env.example
# O que NÃO entra: .git/, AGENTS.md, .mimosa/, node_modules, dist, .env, modelos de ASR
#
# Exit codes: 0 ok · 2 uso inválido · 3 pré-requisito ausente · 4 validação falhou
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OUT="/tmp/voicecast-upload.zip"
OUT="$DEFAULT_OUT"
MODE="build"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    --check) MODE="check"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20; exit 0 ;;
    *) if [[ "$MODE" == "check" && "$1" != -* ]]; then OUT="$1"; shift; else echo "uso inválido: $1" >&2; exit 2; fi ;;
    *) echo "uso inválido: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$1/$2] $3"; }

# python3 com zipfile é o empacotador — zip(1) não existe em toda máquina da casa
require() {
  command -v "$1" >/dev/null 2>&1 || { echo "pré-requisito ausente: $1" >&2; exit 3; }
}
require git
require python3

# ---- validação de um zip (usada no --check e ao final do build) -------------
validate_zip() {
  local zip="$1"
  [[ -f "$zip" ]] || { echo "zip não encontrado: $zip" >&2; exit 4; }

  python3 - "$zip" <<'PYEOF'
import sys, zipfile

z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
fail = []

# 1. nada de .git/ ou AGENTS.md
bad = [n for n in names if n.startswith(".git/") or "/.git/" in n
       or n.endswith("AGENTS.md") or "/AGENTS.md" in n]
if bad:
    fail.append(f"conteúdo proibido no zip: {bad[:5]}")

# 2. nada de node_modules/.env/dist
bad2 = [n for n in names if "node_modules" in n or n.endswith("/.env")
        or "/dist/" in n or ".mimosa" in n]
if bad2:
    fail.append(f"artefatos de build/segredo no zip: {bad2[:5]}")

# 3. essenciais presentes
for want in ("voicecast/package.json", "voicecast/pnpm-lock.yaml",
             "voicecast/.gitignore", "voicecast/src/main/index.ts",
             "voicecast/tests/ipc-contract.test.ts"):
    if want not in names:
        fail.append(f"arquivo essencial ausente: {want}")

# 4. segredo: nenhuma chave real (aceita "test-key" de fixture)
import re
pat = re.compile(rb"(sk-[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]\s*['\"][A-Za-z0-9]{16,})")
for n in names:
    if n.endswith((".ts", ".tsx", ".py", ".json", ".example", ".sh", ".mjs")):
        if pat.search(z.read(n)):
            fail.append(f"possível segredo em {n}")

if fail:
    print("VALIDAÇÃO FALHOU:")
    for f in fail:
        print(f"  - {f}")
    sys.exit(4)
print(f"VALIDAÇÃO OK — {len(names)} arquivos, sanitizado e completo")
PYEOF
}

# ---- modo --check: só valida ------------------------------------------------
if [[ "$MODE" == "check" ]]; then
  validate_zip "$OUT"
  exit 0
fi

# ---- modo build -------------------------------------------------------------
[[ $(git -C "$REPO_ROOT" status --porcelain | wc -l) -eq 0 ]] || {
  echo "ATENÇÃO: working tree sujo — o zip reflete o HEAD commitado, não o que está na tela" >&2
}

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "PLANO:"
echo " 1. git archive do HEAD ($HEAD_SHA) para $STAGE"
echo " 2. remover AGENTS.md e .mimosa"
echo " 3. empacotar em $OUT"
echo " 4. validar o zip (conteúdo proibido, essenciais, scan de segredo)"

log 1 4 "extraindo HEAD"
git -C "$REPO_ROOT" archive HEAD --prefix=voicecast/ | tar -x -C "$STAGE"

log 2 4 "sanitizando"
rm -rf "$STAGE/voicecast/AGENTS.md" "$STAGE/voicecast/.mimosa"

log 3 4 "empacotando"
rm -f "$OUT"
python3 - "$STAGE" "$OUT" <<'PYEOF'
import shutil, sys
shutil.make_archive(sys.argv[2][:-4], "zip", sys.argv[1])
PYEOF

log 4 4 "validando"
validate_zip "$OUT"
echo "PRONTO: $OUT (HEAD $HEAD_SHA) — monte no Taiga com 'Extract archive to: /workspace'"
