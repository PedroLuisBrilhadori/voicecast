# W2b — Wave 1 technical backlog (accumulated neighboring findings) · done

## Objective
Close the 4 neighboring findings that the Wave 1 pilots noted and the tower
queued — all small, all with an owner now.

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocol)
- The repo's `AGENTS.md`
- The items (references in the source briefings):
  1. **runner ignores `req.cwd` on the Windows path** — briefing C4 (Result);
     `src/main/agent/runner.ts`: in the wsl.exe spawn the cwd goes undefined; the goal
     must run in the requested directory (pass `--cwd <dir>` to the headless CLI
     via the sh -lc script, resolving the path for WSL; never interpolated in argv
     — go through ENV like the goal).
  2. **`goalSummary` duplicated** (runner.ts and agent-goal.ts) — same briefing;
     keep ONE source (shared/agent-goal.ts) and re-export.
  3. **The telemetry init's `idle+15s` became unnecessary post-W1** — briefing
     W1 (Result); `src/main/index.ts` still delays the init to not block the
     event loop, but the SDK now runs in a worker_thread; shorten the delay (and
     keep W1's test green).
  4. **`fmtTs` rounds t≈59.7 as "0:60"** — briefing C6 (Findings);
     `src/shared/` (fmtTs moved by C6); round to the next minute
     correctly (`1:00`) and adjust/extend the test.

## Scope
**Do:** the 4 items above, each with a test/test adjustment. Nothing beyond.
**Don't touch:** IPC contract (except nothing), capture, editor, bar, dataset (W2a
is in parallel in OTHER files — don't touch EditorApp/library.ts).

## Verifiable acceptance
- `pnpm ci:local` green; new/adjusted tests per item (4 groups).
- Evidence of item 1: spawn args test on the windows path (goalSpawnArgs)
  containing the resolved cwd.

## Risks and gotchas
- Item 1 is what the maintainer's `--agenttest` gate will exercise on Windows —
  WSL/Windows parity of the spawn path is mandatory (test covers both).
- Item 3: don't touch the worker's design (W1) — only the init scheduling.

## Delivery
Conventional commits (`fix(w2b): …` one per item), no push. Fill in the Result.

## Result (filled in by the pilot)
**Delivered 2026-09-29 — 4/4 items, `pnpm ci:local` green (185 tests passing,
0 failures; 4 skipped = on-demand smokes). Commits (no push):**

1. **req.cwd on the Windows path** — fe4b44c. `goalSpawnArgs` gains `cwd`: on
   Windows the path is resolved for WSL (`winPathToWsl`, shared/paths.ts) and goes
   via ENV `VOICECAST_CWD` — never interpolated in wsl.exe's argv (same
   contract as the goal). Both WSL scripts (legacy and runtime) `cd` at
   the start with a guard for empty and a distinct exit 86 (87 stays = prerequisite).
   Direct keeps the spawn's cwd. *Tests:* goalSpawnArgs windows in both
   modes (runtime/legacy) with `C:\...` → `/mnt/c/...` in the ENV, path absent from
   argv and `cd`/exit 86 in the script; runGoal with `FAKE_PWD` in fake-agent proves the
   cwd on the direct/WSL path (parity of both paths covered).
2. **goalSummary dedupe** — d45e2a6. Single source in shared/agent-goal.ts; the
   runner.ts copy is gone and became a re-export. *Test:* function identity
   (`goalSummaryDoRunner === goalSummaryDaFonte`).
3. **The telemetry init's idle+15s** — 50096f3. Scheduling extracted to
   `src/shared/telemetry-schedule.ts` (pure): initial delay 15s → **2s**
   (post-W1 the SDK runs in a worker_thread; init doesn't block the event loop),
   idle guard kept (5s retry). index.ts only consumes — the worker's
   design (W1) untouched; W1's tests (bridge + real worker) green. *Tests:* fake
   timers (fires at 2s with idle; delays on retry while recording is active).
4. **fmtTs "0:60"** — bb0afcd. Rounds the TOTAL of seconds before breaking into
   m:ss. *Tests:* 59.7→"1:00", 59.4→"0:59", 119.5→"2:00" (+ existing
   regression intact).

**Untouched:** EditorApp/library.ts/ditado.ts (W2a), capture, IPC contract,
W1 worker design (only the init scheduling). New findings: none.
**Pending items/gates:** maintainer validation on Windows (`pnpm dev:win` +
`--agenttest`) — item 1 is truly exercised only there (exit 86 for an inaccessible
cwd appears in the goal's stderr).
