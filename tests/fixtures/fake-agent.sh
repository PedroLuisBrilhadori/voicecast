#!/usr/bin/env bash
# fake-agent.sh — agente fake para os testes do runner (C2).
# Comportamento por env: FAKE_EXIT (exit code), FAKE_SLEEP (s antes de sair),
# FAKE_STDOUT / FAKE_STDERR (textos).
set -u
echo "${FAKE_STDOUT:-ok do agente}"
echo "${FAKE_STDERR:-}" >&2
sleep "${FAKE_SLEEP:-0}"
exit "${FAKE_EXIT:-0}"
