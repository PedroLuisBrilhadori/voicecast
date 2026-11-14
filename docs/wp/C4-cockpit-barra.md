# C4 — Cockpit v1 in the bar (utilityProcess + IPC) · blocked by C2-unlock (U1)

## Objective
The maintainer sees the goal's cycle in the voicecast bar: `listening → routing →
running → done | error`, with the result appearing at the end. The bridge runs
in a utilityProcess (ratified decision): its crash doesn't take down recording/dictation.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-COCKPIT.md` (C2/C4 + decisions)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocol)
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` —
  runGoal/GoalQueue (the worker will host THAT logic; don't duplicate)
- `/home/pedro/programing/projetos/voicecast/src/shared/agent-goal.ts` —
  pure state machine (the bar consumes GoalState)
- `/home/pedro/programing/projetos/voicecast/src/main/index.ts` + `src/shared/ipc.ts`
  + `src/preload/index.ts` — the house's IPC/broadcast registration pattern
- `/home/pedro/programing/projetos/voicecast/src/renderer/BarApp.tsx` — where the
  states appear (follow the `ditado-state` pattern)
- `/home/pedro/programing/projetos/voicecast/vite.config.ts` + `package.json` —
  build (main is tsc→CJS; the worker needs to be its own compiled entry)

## Scope
**Do:**
1. `src/main/agent/worker.ts` — utilityProcess entry: receives
   `{type:"enqueue", req}` / `{type:"status"}` over the MessagePort, hosts
   GoalQueue, answers `{type:"goal-state", state}` on every transition.
2. `src/main/agent/bridge.ts` — utilityProcess.fork of the worker (dist path),
   queue/cleanup on quit, kill-switch `VOICECAST_AGENT_BRIDGE=0` also at
   the fork level. If the fork isn't viable in the current build structure,
   DOCUMENT why and propose an alternative (don't improvise a new build).
3. IPC: new channels in `src/shared/ipc.ts` (`agentRunGoal`, `agentGetState`,
   broadcast event `agent-state` via CaptureEvent or a dedicated channel — follow the
   existing pattern) + preload + handlers in main + test in
   ipc-contract.test.ts (the contract is law).
4. BarApp: goal state line (same visual language as `ditado-state`);
   optional typed input in the panel (voice comes later — F9 already routes).
5. Telemetry (DoD): the runner's already exists (goals/seconds); add counter
   `voicecast_agent_bridge_messages_total{direcao}` for the main↔worker bridge.

**Don't touch:** capture/recording, dictation, editor, permission gate (C5 comes
later), zcode-server protocol (out of scope).

## Verifiable acceptance
- `pnpm ci:local` green; new worker test with MOCKED utilityProcess (fake
  message port) validating the message protocol; IPC contract test.
- `--agenttest "test goal"`: new deterministic hook in the
  `--autotest` style (recorded in main/index.ts): enqueues the goal in the bridge, prints
  states to stdout and exits. Runs on Windows (maintainer validation), but the
  code and the protocol smoke stay green in WSL.

## Risks and gotchas
- utilityProcess uses a compiled JS entry — check that `tsc -p
  tsconfig.node.json` produces `dist/main/agent/worker.js` importable by the fork
  (path relative to dist/main — see how the current main resolves paths in the build).
- OTel in the worker: the runner's telemetry already emits from the process that runs
  runGoal — moving it to the worker, the emits migrate along (the lazy core is per
  process; confirm SDK init in the worker or accept missing spans and
  document — do NOT duplicate SDK init in two processes without checking the
  collector).
- The bar is always-on-top and small: one state line, no intrusive
  notification.

## Delivery
Conventional commits, no push. Fill in the Result below.

## Result (filled in by the pilot)

**Delivered (2026-09-27)** — commits `37ee380`, `a54b22f`, `b69e7a3` (+ docs).
`pnpm ci:local` green: typecheck ×2 · **176 tests** (7 new from the worker with a
MOCKED port + 2 new in ipc-contract) · build produces `dist/main/agent/worker.js`
(CJS, sibling of bridge.js — the fork resolves via `__dirname`, no build change).

**Decisions with evidence (off the briefing's obvious path):**

1. **The C3 enricher runs IN THE MAIN PROCESS, not in the worker** — measured empirically in
   Electron 44 (xvfb smoke): inside utilityProcess `require("electron")` returns
   **only `{net, systemPreferences}`** — there is no `app`. The chain of
   `goalContextEnricher()` (library → storage → `app.getPath("userData")`)
   doesn't run there. The worker hosts the GoalQueue with a **delegate over the port**
   (`enrich-request`/`enrich-result`, fail-soft with a 30s timeout — same
   C3 semantics); the main answers with the production `goalContextEnricher()`.
   The `voicecast_agent_context_total` counter therefore keeps emitting in the main process.
2. **The runner's telemetry migrates with the queue WITHOUT duplicating the SDK** — the utilityProcess
   doesn't initialize the OTel SDK (briefing rule). The worker plugs in a **bridge meter**
   (`setProcessMeter`, new and minimal export in `telemetry.ts`) that relays
   counter/histogram over the port (`{type:"telemetry"}`); the bridge re-emits them in
   the main process's telemetry with the **same names** (`voicecast_agent_goals_total`,
   `voicecast_agent_goal_seconds`, runtime setup counter) — a single
   SDK/exporter (W1's worker thread), no collision in the collector. **The
   `agent.goal` spans stay absent in the worker** (withSpan doesn't cross the port) —
   accepted and documented per the briefing.
3. **An enqueue refusal becomes a synthetic `failed` state** (empty goal / bridge
   off) — the bar shows the WHY, with no new message type in the protocol.

**Scope delivered:** worker + pure protocol (`agent-worker-protocol.ts`) ·
bridge (lazy fork with refork after crash, double kill-switch — fork level AND
runner level — cleanup on will-quit, counter `voicecast_agent_bridge_messages_total{direcao}`)
· IPC `agent:run-goal`/`agent:get-state` + `agent-state` broadcast event in
`CaptureEvent` (house pattern) + preload + contract test · BarApp with a
goal state line (visual language of `ditado-state`, outcome fades after 6s) ·
typed input in the panel (App.tsx, Ctrl+F9) · `--agenttest "goal"` hook
(deterministic with a fake `ZCODE_AGENT_BIN`; prints states to stdout, exit
0 = completed).

**Real E2E smoke in WSL (beyond the mocks, xvfb + Electron):** fork of the
utilityProcess → worker → GoalQueue → fake-agent.sh → `queued → running →
completed` back over the port, with the enrich round-trip answered; kill-switch
`VOICECAST_AGENT_BRIDGE=0` blocks at the fork (`ok:false`).

**Findings (not fixed — out of scope):** the runner ignores `req.cwd` on
Windows (spawn via `wsl.exe` without cwd — C2 behavior); the duplicated
`goalSummary` in `runner.ts` and `agent-goal.ts` (the runner's one isn't used by C4 —
the pure shared one is what's consumed).

**Pending items for the Windows gate (maintainer):** run `pnpm dev:win` +
`voicecast.exe --agenttest "Responda somente: ok"` ["Reply only: ok" — test goal string] (real C2b runtime — validates
wsl.exe spawn, states in the bar and telemetry in Grafana: counters
`voicecast_agent_bridge_messages_total`, `voicecast_agent_goals_total`,
`voicecast_agent_context_total`); validate typed input in the panel.
