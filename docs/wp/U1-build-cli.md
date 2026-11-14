# U1 — Building the ZCode CLI from the open source code · done (exploratory)

## Objective
Produce a `zcode` CLI binary **from the open source repo** (github.com/zai-org/zcode,
main branch) and prove the real headless goal
(`zcode -p "Responda somente: ok" ["Reply only: ok" — test goal string] --surface terminal`). This unlocks C2 of the
cockpit: the installed CLI (0.16.9) doesn't consume `defaultModelSelection` in `-p`,
but the main does (version drift — see the probe's RESULTADOS.md, "Addendum 2").

## Required context (read first)
- `/home/pedro/programing/projetos/voicecast/scripts/probes/2026-09-27-acp/RESULTADOS.md`
  (sections "Roundtrip addendum" and "Addendum 2 — open source") — ALL the
  technical context of the unlock
- `/tmp/zcode-src/` — already-existing shallow clone (if it doesn't exist, clone again:
  `git clone --depth 1 https://github.com/zai-org/zcode.git /tmp/zcode-src`)
- `/tmp/zcode-src/README.md` / `mise.toml` / `package.json` — how to build
  (pnpm workspace; CLI in `apps/zcode-cli`)

## Scope
**Do:**
1. Build the CLI in the clone (`/tmp/zcode-src`) following the repo's
   documentation (expected: install deps with pnpm — system COREPACK/pnpm — and build
   `apps/zcode-cli`; discover the exact command and the generated artifact).
2. Run the headless goal with the new binary, using the same envs we
   validated: `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/tmp/zcode-builtin-provider.json`
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=$HOME/.zcode/v2/provider_config.json`
   (the personal one ALREADY has `defaultModelSelection` saved).
3. If the goal responds: copy the binary to `/tmp/zcode-cli-build/zcode` and
   document the exact build command in `/tmp/zcode-cli-build/BUILD.md`.
4. If the build or the goal fail: document the exact error and how far it got in
   `/tmp/zcode-cli-build/BUILD.md` and STOP (don't improvise patches on the clone).

**Don't touch:** ANYTHING inside `~/.zcode` (user config/credentials),
the voicecast repo, global installs, PATH. Everything confined to /tmp.

## Verifiable acceptance
- `/tmp/zcode-cli-build/BUILD.md` exists, with a reproducible build command and
  the goal's result (real stdout or exact error).
- Best case: the goal answers "ok" (exit 0) — C2 truly unlocked.

## Risks and gotchas
- The build may require a specific node/pnpm version — check mise.toml; if
  incompatible with the environment and there's no quick path, document and stop.
- The clone is shallow (depth 1) — ok for build.
- Reasonable time limit: if past ~20 min of attempts, document and stop.

## Delivery
No commit (work in /tmp). Fill in the Result below.

## Result (filled in by the pilot)
- **Build: OK.** Binary from main (`29628c9`, "feat: update v3.14.3") generated and
  reproducible — full command in `/tmp/zcode-cli-build/BUILD.md`.
  Artifact: `/tmp/zcode-cli-build/zcode` (esbuild bundle 29.7 MB, +
  `provider/zcode-builtin.json` + node 24.14.0 in `/tmp/zcode-cli-build/node24`).
  Nuances: the nested workspace of `apps/zcode-cli` has a stale lock — install and
  build from the ROOT workspace; `dynamic-workflow` needs to be built before
  `core`/`adapters`.
- **Goal: FAILED (exit 1, empty stdout).** stderr: `Error: Model creation
  failed (traceId: 83f20b27-f8a4-4a53-8bdc-5d97b9528ace)`. In the log, the real cause:
  `Select a model before continuing` (CONFIGURATION_ERROR, `turnPhase:
  model_creation`) — that is, main STILL requires selection in `-p`; the
  version-drift hypothesis was necessary but not sufficient.
- **Diagnosis**: the wiring exists in main (`resolveInitialModelSelection`
  consumed at headless boot; default `account:zai-individual-coding-plan/GLM-5.3`
  read from the personal config), but the initial resolution returned "none" — neither the
  default was selectable, nor did the registry fallback find a visible model: the
  registry snapshot at standalone boot came without models. Credentials OK in
  `~/.zcode/v2/credentials.json`. No account/registry events in the info log.
- **Impact on C2**: still blocked; next steps suggested in BUILD.md
  (AccountProviderService debug log; check credential store keys vs
  `readStandaloneAccountProviderConfigSnapshot`; alternative: persist
  `runtime/model_selection` in the db and use `--resume`).
- Declared footprints: normal execution state in `~/.zcode/cli/` (log,
  session, sqlite db migration) — no config/credential changed.
