#!/usr/bin/env bash
# fake-agent.sh — agente fake para os testes do runner (C2/C3).
# Comportamento por env: FAKE_EXIT (exit code), FAKE_SLEEP (s antes de sair),
# FAKE_STDOUT / FAKE_STDERR (textos), FAKE_ECHO_ARGS=1 (ecoa o argv recebido —
# usado p/ provar que o goal enriquecido chega ao agente).
set -u
echo "${FAKE_STDOUT:-ok do agente}"
[ "${FAKE_ECHO_ARGS:-0}" = "1" ] && echo "args: $*"
echo "${FAKE_STDERR:-}" >&2
sleep "${FAKE_SLEEP:-0}"
exit "${FAKE_EXIT:-0}"
