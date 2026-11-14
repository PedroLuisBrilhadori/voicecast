# Delegation — subagents piloting voicecast WPs

Date: 2026-09-27 · Keeps the house rule: the **control tower** (main
session + maintainer) decides direction and validates gates; **pilots**
(subagents) deliver closed WPs.

## Pilot protocol (every delegation follows this)

1. **Read before coding** (in this order): the WP briefing
   (`docs/wp/<id>.md`) · the repo's `AGENTS.md` · the canonical docs the
   briefing cites. The briefing is self-contained — if something essential is
   missing, **stop and report**; don't invent.
2. **Strict scope**: only what the briefing orders. Found a neighboring bug? Note it
   in the briefing's "Findings" section — don't fix it on your own.
3. **Definition of Done** (without this the WP isn't delivered):
   - `pnpm ci:local` green (typecheck + tests + build);
   - **instrumentation born with the feature** (maintainer's rule: span/metric/log
     of the feature in the same commit — see CRONOGRAMA's "Cross-cutting rule");
   - new tests covering the WP's behavior;
   - small, conventional commits (`feat(c6): …`) — no push;
   - briefing updated with result, findings and pending items.
4. **Pilot prohibitions**:
   - NEVER `pnpm dev:win`, sync-to-host, or anything on the Windows copy;
   - NEVER reopen a closed decision (Electron architecture, cockpit
     protocol, read-auto/mutate-human permissions, etc.);
   - NEVER touch anything outside the paths listed in the briefing;
   - NEVER push, deploy, or change user/machine config.
5. **Final report**: what you delivered, evidence (tests/commits), what
   stayed pending and why.

## WP status (kept by the control tower)

| WP | Wave | Status | Parallelizable with |
|---|---|---|---|
| [U1 — open source CLI build](wp/U1-build-cli.md) | 1 | ✅ build ok (esbuild main) | — |
| U2 — standalone diagnostics | 1 | ✅ **root cause + "ok" goal end to end** (`identity` key missing in the credential store; unlock tested via `ZCODE_DATA_BASE_DIR`) | — |
| [C2b — headless runtime wiring in the runner](wp/C2b-wiring-headless.md) | 1 | ✅ **delivered** — real "ok" goal in 9.4s via runGoal (47610fe; 133 tests; Windows gate pending) | — |
| [C3 — context in the goal](wp/C3-contexto-goal.md) | 1 | 🚀 pilot in background (C2 unblocked) | C4 serial |
| [C6 — AN.4: annotations in buildContext](wp/C6-an4-buildcontext.md) | 1 | ✅ **delivered** (d0c7c3f..46a5afb; 103 tests; Windows gate pending) | — |
| [W1 — worker thread for the OTel import](wp/W1-worker-otel.md) | 1 ⚡ | ✅ **delivered** (331e35b; 114 tests; main API intact; Windows gate pending) | — |
| [C7 — hook + .zcode skill](wp/C7-hook-skill.md) | 1 ⚡ | ✅ **delivered** (39 tests; hook `enabled:false` — gate: turn it on + validate with a real session on Windows) | — |
| C2-unlock — validate a real headless goal | 1 | blocked: depends on U1 | — |
| [C3 — context in the goal](wp/C3-contexto-goal.md) | 1 | ✅ **delivered** (6a6d751..2aa5fe1; 167 tests; Jev-absent policy documented) | — |
| [C4 — cockpit in the bar (utilityProcess+IPC)](wp/C4-cockpit-barra.md) | 1 | ✅ **delivered** (37ee380..5311384; 176 tests; real E2E smoke with xvfb; Windows gate: `--agenttest`) | — |

> **Wave 1 (cockpit v1) — code complete** (2026-09-27). Maintainer gates:
> (1) `pnpm dev:win` — validates editor phase B, C6, W1, C2b/C3/C4 via
> `voicecast.exe --agenttest "Responda somente: ok"` ["Reply only: ok"] (states in the bar);
> (2) turn on the C7 hook (`enabled:true` in zcode.json) + F9 with a real session.
| C5 — local permission gate | 1 | blocked: C4 | — |
| [W2a — dictation correction + dataset (#3+#5)](wp/W2a-correcao-dataset.md) | 2 | ✅ **delivered** (1dda3f6..fa00a6a; 219 tests; Windows gate pending) | W2b (disjoint files) |
| [W2b — Wave 1 technical backlog (4 findings)](wp/W2b-backlog-tecnico.md) | 2 | ✅ **delivered** (fe4b44c..83deff6; 185 tests; cwd on Windows exercised in the `--agenttest` gate) | — |

## Briefing template (`docs/wp/<ID>-<slug>.md`)

```
# <ID> — <title> · <status>
## Objective (1–2 sentences, in product vocabulary)
## Required context (absolute paths to read first)
## Scope: do / don't touch
## Verifiable acceptance (commands + observable effects)
## Required instrumentation (metric/span names)
## Repo risks and gotchas
## Delivery (commits, Result section filled in at the end)
## Result (filled in by the pilot)
```

## How the tower orchestrates

- Pilots run as **background agents** (in parallel whenever the
  "Parallelizable" column allows); the main session continues on other fronts.
- Human gate (maintainer) at the end of each wave: Windows validation via
  `pnpm dev:win` — a pilot never validates alone on Windows.
- Pilot result = commits in the repo + briefing filled in; the tower
  checks ci:local and closes the WP.
