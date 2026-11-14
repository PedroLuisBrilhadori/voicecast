# Plan — Consistent Jev + computer use in voicecast + ZCode integration

Date: 2026-09-21 · Status: **approved by the maintainer**
Re-presents the plan truncated from session `sess_bc340fad` (FJ milestone), now with the
evidence from the 2026-09-21 discovery
([probes](../scripts/probes/2026-09-21-discovery/RESULTADOS.md)).

## Decisions already closed by the maintainer (inherited, do not reopen)

1. **Phases**: consolidation of the Jev client + post-session judging **first**;
   computer use **later**.
2. **voicecast hosts the** computer use loop (not an external script).
3. Execution target: **Windows/pchome** (port via UI Automation).
4. Consolidate Jev callers into **one client + official SDK** (`@typesafe-ai/sdk`).
5. Target harness: **ZCode** (opencode retired) — integration via native
   `zcode.json` (MCP stdio, hooks, skills), not via the opencode2 server.
6. Multi-machine fabric via the **mcp-peer** pattern (pchome-win ↔ note ↔ macmini;
   s10deck in the future) is a multiplier for the project.

## Evidence backing the plan (probes 2026-09-21, all passed)

| Verified | Result |
|---|---|
| Jev `systemone` with choice+2×noul+score over a transcript | 200 OK · 741ms · `comando_agente` route 0.98 · risk 0.97 · relevance 2.92/3 |
| Current API schema | only `noul\|choice\|score`; local `jev-judge.ts` is in **drift** (`boolean` → 400) |
| WinRT OCR on Windows (WSL interop) | 444ms pt-BR zero-dep, reads the real screen |
| UIA of the ZCode window (Electron) | 381 nodes/140ms, 72 InvokePatterns |
| Reference project | `awlevin/typesafe-computer-use` (MIT, macOS): OCR+AX → Jev Choice → action; single adapter `macos.py` |
| ZCode `computer-use` plugin | target mac/win/linux; in cache, **not enabled** |
| F0 (runtime) | Electron chosen; MP4 ≤30MB for Read; DPI 1.53; remux mandatory |

---

## Stage 1 — Jev foundation: a single client (workspace) · S

**Objective**: eliminate the drift and the 3 parallel implementations
(`jev-guardrail.mjs`, `jev-judge.ts`, `jev-qa`), creating the canonical client.

1. **`scripts/lib/jev-judge.mjs`** — plain ESM (importable by pure `node`
   hooks and by tsx scripts). Inside it uses `@typesafe-ai/sdk` (retry/types);
   outside it keeps the house API shell (`{state, questions} → answers`).
   - Schema fixes: no `boolean` (map to noul with criteria
     `{true,false}`); **new `choice`** (criteria = map option→description;
     answer `{choice, probabilities, confidence}`); score with ordered criteria
     array (answer carries `legend`).
   - Questions/policies and thresholds **in a single reviewable file** (guidance
     from the official TypeSafe doc).
   - Telemetry: JSONL event per call (origin, latency, tokens) in the
     guardrail pattern (`~/.local/state/`) → OTel sidecar → existing dashboard.
   - Fail-loud as today (the caller decides the fallback).
2. **Migrate the 3 callers** to the canonical client. Behavior preserved:
   golden tests of the guardrail's current verdicts before/after.
3. Tests: `node --test scripts/*.test.mjs` green; `jev-calibrate.ts`
   working over the new client (threshold regression).

**Acceptance**: guardrail blocks/allows identically (golden tests); probe
`jev-systemone-voicecast.mjs` runs via the new client with choice; events
arriving in the "Agentes · Infra MCP, Guardrail & Perguntas" dashboard.

**Risks**: the early-access API may change again → golden tests + a single
client make the drift visible in one place.

## Stage 2 — Judging inside voicecast (post-session + F9) · M

**Objective**: the app decides with Jev, at the right time, without an LLM in the loop.

1. **`src/main/jev.ts`** — app wrapper using `@typesafe-ai/sdk` directly
   (own repo has package.json; key via the Windows machine's env) +
   `src/main/jev-questions.ts` (versioned questions). OTel metrics
   (`voicecast_jev_seconds`, `voicecast_jev_decisions_total{rota}`).
2. **Post-session** (recording stop): one `systemone` call — relevance
   (score 0–3), route (choice), risks (noul) — recorded in `meta.json`
   (`jev` field); feeds the handoff digest (what deserves to go to the agent).
3. **F9 dictation** (fits into the existing `ditado.ts`): after transcription, route
   the intent (choice: `ditado_texto | comando_agente | anotacao_contexto |
   conversa_social`). Confidence gate: ≥0.9 executes the route on its own
   (`ditado_texto` pastes as today; `comando_agente` → Stage 3; `anotacao`
   → attaches to the current session); <0.9 shows options in the dictation bar.
4. Tests with transcript fixtures (unit, no network) + 1 integration test
   with the real API behind a flag.

**Acceptance**: a real session produces `meta.json.jev`; dictation "abre um PR…" ("open a PR…" — example utterance) routes
`comando_agente`; social chat doesn't become a handoff; judging p95 latency
< 1.5s in the dashboard. **Depends on**: Stage 1.

## Stage 3 — ZCode integration: context first · M

**Objective**: a ZCode agent consuming voice+screen without friction and without blowing up
context.

1. **`voicecast` MCP** (stdio, pure Node, mcp-peer pattern, reads
   `%LOCALAPPDATA%\voicecast` — from WSL via `/mnt/c`): tools `sessions_list`,
   `session_get {id}` (meta + digest + transcript), `sessions_search {q}`,
   `latest_context {minutos}`. Registration in the root `zcode.json`.
2. **UserPromptSubmit hook** (house hook pattern): injects the last session's
   digest if < N minutes (bounded ~500 tokens, respecting the Stage 2
   relevance score — only injects what Jev scored ≥2).
3. **`.zcode/skills/voicecast/` skill** — how to ask for context, artifact
   contract (screenshots/clips/transcript ≤30MB, F0 rule).
4. (Parallel, optional) adapt the official TypeSafe skill
   (`npx skills add typesafe-ai/skills`) to `.zcode/skills/`.

**Acceptance**: in ZCode, "what did I say in the last session?" is answered via MCP
without a manual file; the hook injects the digest without blowing the context budget;
integration runbook in the repo. **Depends on**: Stage 2. Perception spikes of
Stage 4 can move in parallel.

## Stage 4 — Computer use in voicecast (Windows port) · L

**Objective**: voice/goal → perception → Jev decides → action loop, hosted in the app,
auditable. Reference: `awlevin/typesafe-computer-use` (`macos.py` adapter →
our `src/main/cu/win32`).

1. **FD.1 Perception** (`src/main/cu/perceive.ts`): frame from
   `desktopCapturer` (already in `capture.ts`) + WinRT OCR (PowerShell
   helper inlined — probe: 444ms) + UIA walk (PS/koffi helper — probe: 381 nodes/
   140ms) → **textual state** (named controls + invokables + OCR lines
   with positions). Tile caching as in the original project (optional).
2. **FD.2 Decision** (`src/main/cu/decide.ts`): one `systemone` call per
   step — `kind` choice (`click_item | use_browser | type_text | scroll |
   press_key | done | none`) + `item` choice; optional writer for free text
   (GLM/Haiku — never types a password). Stall rules: confidence <0.4, 2 no-ops,
   step limit.
3. **FD.3 Action** (`src/main/cu/act.ts`): **InvokePattern (UIA) preferred**
   (doesn't steal focus — AXPress parallel); SendInput via koffi as fallback
   (port of `voice/platform/win32.py`, INPUT struct cbSize 40); scroll/drag.
4. **FD.4 Security**: noul risk gate before a mutating action (same policy
   as the guardrail — consistency is the point); physical kill switch (mouse to the corner,
   as in the original) + button in the bar; **every CU execution is recorded as a
   voicecast session** (audit + dataset).
5. **FD.5 Triggering**: by voice (F9 → `comando_agente` route + CU intent) or
   goal typed in the bar; overlay showing the loop state.

**Progressive acceptance**: FD.1 logs the focused window's textual state; FD.2 decides
correctly in a fixed scenario; FD.3 opens a URL in the browser with the kill switch
working; FD.5 completes a 5-step script with session recording.

**Risks**: DPI 1.53 (coordinates in physical px from day 1 — F0 lesson);
OCR I/l (UIA complements); wrong window/no focus (bind by pid+window_id as
ZCode's CUA does); Mimosa guard on paths (literals/sanitized).

**Depends on**: Stages 1–2.

## Stage 5 — Multi-machine fabric · S/M

**Objective**: context and actions reachable from any machine with an agent.

1. voicecast MCP accessible from note/macmini via SSH stdio (same mcp-peer
   design: registration in the other machines' zcode.json pointing to the
   pchome; `INFRA_MCP_LEVEL=ro` for outside reads).
2. s10deck as a peer (Termux/ssh) — inventory; mic/camera as future remote
   capture.
3. Coexistence policy of the two CUs: **ZCode's CUA** (official plugin,
   installed from the marketplace) for agent-initiated tasks; **voicecast loop**
   for voice-initiated ones; `jev-guardrail` extending the matcher to the CUA
   surface (UI-mutation gray zone) — same telemetry.

**Acceptance**: from the note, an agent queries voicecast's `sessions_search` on the pchome;
CU policy documented in a runbook; ZCode's `computer-use` plugin
installed with `computer.target` verified in the
desktop-attached-remote topology. **Depends on**: Stages 3–4 (the plugin
spike is independent and can happen early).

---

## Sequence and parallelism

```
E1 ──► E2 ──► E3 ─────────────► E5
           └───► E4 (FD.1→FD.5) ─┘   (FD.1 spikes parallel to E3; CUA plugin: any time)
```

Relative size: E1 S · E2 M · E3 M · E4 L (FD.n sub-milestones) · E5 S/M.
Each stage closes with a report in the `docs/` folder (RELATORIO-F0 pattern) and, when
there is durable learning, a note in the vault via the `capturar-nota` skill.

## Out of scope (for now)

- Streaming/vision in Jev (the API doesn't accept images; the design already works around it).
- Dictation on macOS/Linux (focus on pchome-win; isolated adapter leaves the port open).
- Replacing ZCode's CUA with the voicecast loop (coexistence, distinct roles).
