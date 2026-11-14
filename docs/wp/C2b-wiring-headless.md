# C2b — Wiring the headless runtime into the runner · ✅ delivered (live goal ok)

## Objective
Make DURABLE and standard the unlock proven by U2: the voicecast
runner uses the CLI built from open source with its own self-curated data-dir, and a
real goal runs end to end via `runGoal` (evidence recorded).

## Required context (read first)
- `/tmp/zcode-cli-build/BUILD.md` — SECTION "U2 — standalone diagnostics":
  root cause (`account-provider:<providerId>:identity` key missing in
  credentials.json), the idempotent injection script and the
  `ZCODE_DATA_BASE_DIR` env (copy of credentials + identity keys; self-heal at
  every start).
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` —
  `agentRunnerConfig`/`goalSpawnArgs` (this is where the wiring goes)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGATION.md` (protocol)
- The repo's `AGENTS.md`

## Scope
**Do:**
1. Script `src/main/agent/runtime-setup.ts` (pure Node, testable): guarantees in
   `~/.local/state/voicecast/zcode-runtime/`:
   - `zcode` (binary) + `node24/` copied from `/tmp/zcode-cli-build/`
     (IF they exist; otherwise a clear error instructing to run U1 — distinct
     exit code for missing prerequisite);
   - `zcode-data/` with credentials.json copied from `~/.zcode/v2/` +
     injected identity keys (idempotent; re-copies if the original's mtime
     changed = self-heal if the desktop rotates). NEVER log secrets;
   - returns the ready envs: `ZCODE_DATA_BASE_DIR`,
     `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (if applicable — check BUILD.md).
2. Runner: `agentRunnerConfig` now resolves the binary from runtime setup
   (env `ZCODE_AGENT_BIN` keeps overriding); direct spawn on Linux
   uses `node24` + binary; Windows keeps `wsl.exe` (the script runs inside
   WSL — WSL paths, not Windows).
3. LIVE test behind a flag: `tests/agent-live.test.ts` running a real goal
   ("Responda somente: ok" ["Reply only: ok" — test goal string]) via `runGoal` ONLY if
   `VOICECAST_AGENT_LIVE=1` (CI default = skip) — it's C2's continuous proof.
4. Telemetry (DoD): counter `voicecast_agent_runtime_setup_total{resultado}`
   (ok | stale | sem-build) in the setup.

**Don't touch:** `~/.zcode` (read-only), utilityProcess/bar (C4),
context in the goal (C3), the zcode-server protocol.

## Verifiable acceptance
- `pnpm ci:local` green (the live test skips by default).
- `VOICECAST_AGENT_LIVE=1 pnpm vitest run tests/agent-live.test.ts` → "ok"
  goal with real stdout, phase=completed (evidence pasted into the Result).
- Setup unit tests: idempotent copy, self-heal by mtime, clear error
  without build, secrets never in stdout.

## Risks and gotchas
- The U1 binary is esbuild for node 24 — spawn ALWAYS with the runtime dir's
  node24, not the system node.
- Execution permissions on copy (chmod +x).
- Copied credentials = sensitive file in ~/.local/state — chmod 600 and
  NEVER print its content.

## Delivery
Conventional commits (`feat(c2b): …`), no push. Fill in the Result below.

## Result (filled in by the pilot)

**DELIVERED (2026-09-27, C2b pilot).** `pnpm ci:local` green (133 tests, live
skipping by default) and the REAL goal answered end to end via `runGoal`.

### LIVE evidence (mandatory)

`VOICECAST_AGENT_LIVE=1 pnpm vitest run tests/agent-live.test.ts` (first
run; the duration includes the runtime's initial materialization — 229 MB):

```
[live-c2b] {"phase":"completed","exitCode":0,"durationMs":46976,"agentBin":"/home/pedro/.local/state/voicecast/zcode-runtime/zcode"}
[live-c2b] stdout: "ok\n"
✓ tests/agent-live.test.ts (1 test) 46982ms
```

Observable state post-run (verified without printing secrets):
- `~/.local/state/voicecast/zcode-runtime/` materialized: `zcode` (755),
  `node24/` (bin 755), `provider/zcode-builtin.json`, `zcode-data/` (700) with
  `credentials.json` (600) — 8 keys (6 from desktop + 2 injected identity).
- `~/.zcode/v2/credentials.json` INTACT: 6 keys, 0 identity (read-only
  respected). The CLI wrote `telemetry-state.json` inside its own
  data-dir (`ZCODE_DATA_BASE_DIR` behavior, already noted in U2)
  and normal logs/db in `~/.zcode/cli/` (U1/U2 precedent).

### What was implemented

1. `src/main/agent/runtime-setup.ts` (pure Node, no electron): idempotent `ensureRuntime`
   with mtime self-heal — copies `zcode`+`node24/`+provider from the
   U1 build to `~/.local/state/voicecast/zcode-runtime` (paths via env
   `VOICECAST_ZCODE_BUILD_DIR`/`VOICECAST_RUNTIME_DIR`), assembles
   `zcode-data/.zcode/v2/credentials.json` (600) with `injectIdentityKeys`
   (U2 regex: `account-provider:<providerId>:identity` = UUID of the
   api-key name; idempotent), returns the ready envs (`ZCODE_DATA_BASE_DIR`,
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
   when it exists). Per-process cache (`ensureRuntimeCached`) — self-heal 1x
   per bridge start. Counter
   `voicecast_agent_runtime_setup_total{resultado}`.
2. `src/main/agent/runner.ts`: `agentRunnerConfig` resolves the binary from the
   runtime (env `ZCODE_AGENT_BIN` keeps overriding AND disabling the
   runtime setup — back-compat with the old behavior); direct Linux spawn is
   `<node24/bin/node> <zcode> -p <goal>` with the setup envs; Windows keeps
   `wsl.exe --exec sh -lc` with a single-line script that guarantees binaries (cp from
   the build), runs the credentials self-heal INSIDE WSL via
   `node24 -e "$VOICECAST_SETUP_JS"` (same logic, parity guaranteed by
   test) and execs with the runtime's node24 — `$HOME` paths (WSL), never Windows.
   `runGoal` fails clearly when the setup fails (the prerequisite error becomes
   goal failed with the message pointing to U1).
3. Tests: `tests/runtime-setup.test.ts` (16 — idempotent copy, mtime self-heal →
   `stale` result, durable without buildDir, `SEM_BUILD`/
   `SEM_CREDENCIAL`, secrets never in stdout, self-heal JS parity
   including exit 87) and `tests/agent-runner.test.ts` (12 — runtime
   defaults, override, node24+binary spawn, WSL script with exit 87 and goal only
   via ENV) + `tests/agent-live.test.ts` (live behind
   `VOICECAST_AGENT_LIVE=1`, skip default).

### Conscious decisions and deviations (for the tower to validate)

- **Counter**: beyond `ok | stale | sem-build`, `sem-credencial` was born
  (desktop credentials missing = user without login) — a real failure that isn't
  "no build"; briefing taxonomy extended out of honesty.
- **Durability**: if the runtime dir is already complete, the buildDir is NOT
  required (survives a reboot that wipes /tmp); the build is only needed to
  materialize/refresh. Build newer than the copy (mtime/size) → refresh and
  `stale` result.
- **`stale`** = any re-copy over existing material (rotated credentials
  OR U1 rebuild). First provisioning and "nothing to do" =
  `ok`.
- **Windows**: the credentials self-heal inside WSL uses
  `VOICECAST_SETUP_JS` via the spawn env (same mechanism as C2's
  `VOICECAST_GOAL`). The wsl.exe→WSL hop follows the pattern already adopted in C2 and stays under the
  human gate of Windows validation (`pnpm dev:win`) — the pilot doesn't validate
  Windows.
- No utilityProcess/bar (C4 untouched), no context in the goal (C3 untouched),
  zcode-server protocol untouched.

### Pending items / findings

- Human gate: Windows validation via `pnpm dev:win` (wsl.exe spawn +
  self-heal inside WSL).
- The CLI's `telemetry-state.json` appears in its own data-dir
  (`ZCODE_DATA_BASE_DIR` behavior confirmed at runtime — U2 note validated).
- Neighboring finding (not fixed, strict scope): the live spent ~47s on the
  first run because of the synchronous 229 MB copy on the main process's event loop
  (fs/promises — threadpool, but ensure is `await`ed inside the first
  goal). Following runs are stat-only + goal (~7s in U2). If it bothers,
  candidate for a worker (W1 pattern) in a future WP.
- Build durability: `/tmp/zcode-cli-build` disappears on reboot; with the runtime
  already materialized this does NOT break (tested), but the binary
  refresh (U1 rebuild) only works with the build present again.
