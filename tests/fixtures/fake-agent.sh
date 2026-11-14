#!/usr/bin/env bash
# fake-agent.sh — fake agent for the runner tests (C2/C3/W2b).
# Behavior via env: FAKE_EXIT (exit code), FAKE_SLEEP (s before exiting),
# FAKE_STDOUT / FAKE_STDERR (texts), FAKE_ECHO_ARGS=1 (echoes the received argv —
# used to prove the enriched goal reaches the agent), FAKE_PWD=1 (echoes the
# process cwd — proves the goal runs in the requested directory).
set -u
echo "${FAKE_STDOUT:-ok do agente}"
[ "${FAKE_ECHO_ARGS:-0}" = "1" ] && echo "args: $*"
[ "${FAKE_PWD:-0}" = "1" ] && echo "pwd: $PWD"
echo "${FAKE_STDERR:-}" >&2
sleep "${FAKE_SLEEP:-0}"
exit "${FAKE_EXIT:-0}"
