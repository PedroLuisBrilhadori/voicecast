# Plan — Voice cockpit: voicecast as the agent's front door (Wave 1)

Date: 2026-09-27 · Status: **ratified by the maintainer** (decisions below)
References: [CRONOGRAMA](CRONOGRAMA.md) Wave 1 · [PLANO-JEV-CU](PLANO-JEV-CU.md)
Stage 2 (`comando_agente` route) · [RELATORIO-E2](RELATORIO-E2.md)

## FD.0 discovery (2026-09-27) — the engine is drivable, no hacks

ZCode Desktop runs its own server — `~/.zcode/server/zcode-server.cjs`
with a dedicated node (`~/.zcode/server/node`) — and talks to it **over stdio
pipes** (no HTTP port; confirmed on the live process). The protocol extracted
from the production bundle exposes, among others:

```
initialize · session/create · session/send · session/list · session/read ·
session/stop · session/goal · session/subscribe · session/events ·
session/messages · session/fork · session/resume · session/compact ·
turn.started · turn.completed · turn.failed · state.updated ·
permission.respond · elicitation.respond · model.set · mode.set · workspace.set
```

**Consequence**: voicecast (Electron main, Node) can spawn the server and
speak the SAME protocol as the Desktop — first-class agent triggering,
without pasting text or reading UIA (which remain only as fallback). No
opencode2/4096 server: decision #5 of PLANO-JEV-CU still stands (target
harness = ZCode).

Environment detail: the server runs in WSL; voicecast runs on Windows. The
spawn goes through `wsl.exe -e <node> <server.cjs>` — stdio pipes pass through
unharmed (same mechanism the Desktop uses today in the Windows↔WSL bridge).

## Objective / non-objectives

**Objective**: speak a goal into the F9 (`comando_agente` route) and have it run on a
real ZCode agent — without typing — with live state in the bar, a local
permission gate and an auditable outcome in the voicecast session.

**Non-objectives**: embedding the ZCode UI in voicecast; replacing ZCode's
CUA; multi-machine (that's Wave 5); TTS (M3, later).

## Architecture

```
F9 (voice) → dictation → ASR → Jev comando_agente route (conf ≥0.9)
   └─► src/main/agent-bridge.ts (NEW)
         ├─ spawn zcode-server via wsl.exe (stdio; 1 goal at a time)
         ├─ initialize → session/create (default mode/model)
         ├─ session/send(goal + bounded context from the last session)
         ├─ session/subscribe → turn.* → states in the bar (broadcast)
         ├─ permission.respond ← local gate (guardrail policy)
         └─ turn.completed → outcome → bar + meta.json.agentGoals[]
```

## Work packages

### C1 — Protocol probe (S) · DONE (2026-09-27)
Standalone script in `scripts/probes/2026-09-27-acp/`:
`probe-acp.mjs` (handshake+framing decoded) and `probe-roundtrip.mjs`
(real roundtrip). Complete results in the probe's `RESULTADOS.md`. In
short: ndjson handshake `zcode-hello/ack` ✓ · VS Code binary framing
(13B) ✓ · byte-exact serializer ✓ · args as positional ARRAY ✓ ·
`zcode-agent.createSession {workspacePath}` reaches the server ✓. **However**: the
server is a *relay* — on session creation the nested agent
(`agents/glm/zcode-agent`) asks for runtime preferences back and whoever answers
is the **desktop authority**; without a desktop, `createSession` times out.
Replicating the authority = unstable, version-coupled surface.

**Pivot ratified by the finding (2026-09-27)**: bridge v1 **does not use the
middleman** — it uses the CLI's first-class headless mode
(`zcode-agent -p "<goal>" --surface terminal`, with `--attach`, `--resume`,
`--mode`). Same binary/plan/credentials as the desktop
(`~/.zcode/v2/credentials.json`); zero reverse protocol.

### C2 — `agent-bridge` in a utilityProcess (M) · core implemented (2026-09-27)
- `src/shared/agent-goal.ts`: pure state machine
  (queued→running→completed/failed/timeout/cancelled) + summaries for the bar.
- `src/main/agent/runner.ts`: goal runner — Linux/WSL direct spawn,
  Windows via `wsl.exe --exec sh -lc` with **goal via env** (never interpolated
  argv), queue of 1 (`GoalQueue`), timeout with SIGTERM→SIGKILL,
  kill-switch `VOICECAST_AGENT_BRIDGE=0`, telemetry
  (`voicecast_agent_goals_total{desfecho}`, `voicecast_agent_goal_seconds`,
  span `agent.goal`).
- Tests: `tests/agent-goal.test.ts` + `tests/agent-runner.test.ts` (fake
  agent `tests/fixtures/fake-agent.sh`) — 14 new, 86 total.
- **Single blocker (config, not code)**: the headless CLI requires a prior
  model selection ("Select a model before continuing") — the desktop selects
  via UI and the state lives in the shared db (`runtime/model_selection`,
  `session_entry` per session). Pending: define the official path — first
  selection via TUI, CLI flag/config, or db seed — to be decided with the
  maintainer. UtilityProcess + IPC + bar = next step (pattern already
  ratified, code awaits the blocker above).

### C3 — Context in the goal (S)
The goal carries the bounded `buildContext` of the last session (if < N minutes and
Jev relevance ≥2 — the same policy designed for the hook). Reuses `buildContext`,
truncates at ~2k tokens, cites artifact paths.
**Instrumentation**: `voicecast_agent_context_total{com,sem}`.
**Acceptance**: a goal after a recent session cites the context; a cold goal carries nothing.

### C4 — Cockpit v1 in the bar/panel (M) · what you see
States in BarApp (complementing `ditado-state`): `idle → listening →
routing → running(goal, with turn summaries) → done | error`. Alternative
typed input in the panel (no voice). Outcome persisted in the current
session's `meta.json.agentGoals[]` (ties voice↔agent in the audit).
**Acceptance**: say "abre um PR…" ("open a PR…" — example spoken goal) and follow the cycle in the bar without typing.

### C5 — Local permission gate (M) · house security
When the server asks for `permission.respond`, the bridge consults the local Jev
gate (`jev-questions`, same policy as the guardrail): read auto-approved,
gray-zone mutation → human confirmation in the bar (or direct block if
risk is high). A secret never goes into the goal (Jev already scores risk).
**Instrumentation**: `voicecast_agent_permissions_total{decisão}`.
**Acceptance**: a goal that tries a command blocked by the guardrail is denied without
typing intervention; reads flow on their own.

### C6 — AN.4: annotations in buildContext (S)
Marks (`annotations.jsonl` + burned-in screenshots) enter as context
lines in `buildContext` — closes the annotation plan's pending item.

### C7 — ⚡ parallel (non-blocking)
`UserPromptSubmit` hook + `.zcode/skills/voicecast/` skill (bounded digest in
ZCode when you work inside it) · worker thread for the OTel SDK import ·
`computer-use` plugin spike.

## Security

Permission judged locally (C5) · goals and outcomes audited in the session ·
bridge kill-switch · no secret in the goal (existing Jev policy).

## Tests

Unit (WSL, no network): bridge × fake stdio server; gate; bounded context;
new IPC contract (agent state for the bar). Windows smoke: `--agenttest`.
CI follows `pnpm ci:local`.

## Decisions ratified by the maintainer (2026-09-27)

1. **Workspace (cwd) of goals**: per **different directories** — selectable
   per goal (spoken/typed), defaulting to the last one used. The cockpit panel
   offers the list; the goal can name the target.
2. **Mode/model**: **voicecast's own explicit config** (own file in
   `%APPDATA%\voicecast\agent.json`, doesn't inherit ZCode settings); overridable
   per goal.
3. **Permission**: auto-approve reads, require a human for mutation (mirrors the
   guardrail).
4. **Where the bridge runs**: **utilityProcess** (crash isolation — a bridge
   crash doesn't take down recording/dictation).

## Sequence and estimate

```
C1 (probe) → C2 (bridge) → C3 ∥ C4 → C5 → C6      ⚡ C7 all the time
```
~2–3 agent sessions + 2 human gates (Windows validation). Everything
instrumented per WP (cross-cutting rule of the schedule).
