# Schedule — voicecast until "done"

Date: 2026-09-23 · Status: **proposal** (maintainer ratifies it by validating Wave 0)

Consolidates what's left: Stages 3–5 of [PLANO-JEV-CU](PLAN-JEV-CU.md), M3/M4 from
the original vision, telemetry pending items ([REPORT-TELEMETRY](REPORT-TELEMETRY.md)),
the AN.4 pending item from the annotation plan and issues #3/#4/#5.

## Pace assumptions

- Observed pace 19–23/09: several fronts per business day, with the maintainer
  validating on Windows (`pnpm dev:win`) the same day. **The dates below assume
  this pace; if it slips, the dates slide — the sequence and the dependencies don't.**
- Each front closes with commit + Windows validation by the maintainer (human
  gate) and a report in `docs/` when it's a milestone.
- **Instrumentation comes with the front** (see "Cross-cutting rule" below).
- Items marked ⚡ are orthogonal and can move in parallel (including
  delegated to background subagents).

## Already closed (do not reopen)

F0 ✅ · M0–M2 ✅ (+ editor phase B 2026-09-23, Windows validation pending) ·
v2 F9 dictation + hosted ASR ✅ · Jev E1/E2 ✅ · AN.1/2/6 ✅ · OTel telemetry
end to end ✅.

---

## Wave 0 — cash in what's already done · 23–24/09 (minutes, human)

| # | Item | Who |
|---|---|---|
| 0.1 | Validate editor phase B on Windows: segment, ✂ clip, export cut, "copy context" with the Trechos (Excerpts) section | maintainer |
| 0.2 | Push pending commits (4 ahead of origin) | maintainer |
| 0.3 | Visual check of the `voicecast` dashboard in Grafana (telemetry pending item) | maintainer |

## Wave 1 — Harness metamorphosis: voicecast as the agent's cockpit · M/L · 27/09–02/10

> Detailed, **ratified** plan: **[PLANO-COCKPIT](PLAN-COCKPIT.md)** (WPs
> C1–C7, testing, security, decisions closed on 2026-09-27). FD.0 resolved
> (2026-09-27): the ZCode engine is drivable over **stdio** (`zcode-server.cjs`,
> protocol `session/create/send/subscribe` + `turn.*` + `permission.respond`)
> — the cockpit drives a first-class agent, no UIA/pasting (those stay as
> fallback).

Maintainer's direction (2026-09-23): the desired integration **is not "ZCode
queries voicecast"** (the MCP was left ownerless for now) — it's **voicecast
moving up from recorder to the agent's front door**. ZCode becomes the engine behind it.

1. **FD.0 spike — trigger a goal in ZCode programmatically** (S, first):
   - Clean path: bring up the harness (`scripts/opencode-harness.sh start` at
     the root — server on `127.0.0.1:4096`) and map the API to create a session /
     submit a prompt. Initial finding (2026-09-23): the server exists
     (`~/.zcode/server/zcode-server.cjs`), currently **down**.
   - Fallback v0 (nearly free): F9 routing `comando_agente` already pastes the goal into the
     focused ZCode window (E2) + UIA reading of the window (probe: 381 nodes in
     140ms) to follow the outcome without typing anything.
2. **Cockpit v1 in the bar/panel**: spoken goal → handed to the engine → live
   state in the bar (running/done/error) → narrated result (TTS matches
   M3; in v1 text in the bar suffices).
3. **AN.4**: annotation marks (annotations.jsonl + burned-in screenshots) in
   `buildContext` — context remains the product.
4. ⚡ Parallel: hook `UserPromptSubmit` + skill `.zcode/skills/voicecast/`
   (digest bounded by Jev relevance ≥2) — cheap and independent of the cockpit:
   when you work INSIDE ZCode, the last session's context arrives on its own.
5. ⚡ Parallel: **worker thread for the OTel SDK import** (residual from the REC delay).
6. ⚡ Parallel (5 min spike): enable ZCode's official `computer-use` plugin
   via marketplace (light prerequisite of E5).

**Acceptance**: say "abre um PR…" ("open a PR…" — example spoken goal) into the F9 and the goal runs on a real agent without
typing anything, with the outcome visible in the bar.

**Sessions MCP** (`sessions_list`/`session_get`/`sessions_search`/
`latest_context`) → **postponed to Wave 5** (it only gets an owner with the
multi-machine fabric).

## Cross-cutting rule — observability per feature (maintainer, 2026-09-23)

**What ran, how, and what happened must always be recorded.** Every
new feature is born instrumented (span/metric/log → local collector):
instrumentation is part of the front's own acceptance — there is no
"telemetry wave" after the fact. The services (collector/Prometheus/Tempo/Grafana)
are already up; the rule is to use them in every delivery.

- Retro coverage of the already-existing fronts (dictation-start, ASR host/boot,
  global errors): small items inside whichever wave touches each path.
- ⚡ Small enabler (any wave): app logs → Loki (OTLP handler) —
  unlocks the log as a first-class signal for the following fronts.

## Wave 2 — Product & dataset: definitive retirement of voice-dictation · S/M · 29/09–03/10
2. **Issue #5** voice-dictation parity: close what the migration dropped.
3. **Issue #3** training dataset: dictation correction/labeling screen inside
   voicecast (replaces the :8700 panel) — last step of the daemon's retirement.
4. ⚡ Optional: **Issue #4** WASAPI loopback (system audio as a track).
5. Gate: dashboard reviewed by the maintainer; voice-dictation daemon removed
   from the boot routines if #5+#3 close.

## Wave 3 — M3 live mode + TTS · M · 06–10/10

1. Live mode spike (streaming transcription while recording — the hosted ASR
   already runs locally; decide the partials window vs wave-file per marker).
2. Live mode UI in the REC bar (live partial transcription).
3. Local TTS (ASR's pair: same host-local philosophy).
4. Gate: real session with live transcription + TTS validated on Windows.

## Wave 4 — Jev Stage 4: computer use in voicecast · L · 13–24/10

Windows port of the voice→perception→Jev→action loop (reference
`awlevin/typesafe-computer-use`). Progressive acceptance already defined in the plan:

| Sub | Deliverable | Acceptance |
|---|---|---|
| FD.1 | Perception (`cu/perceive.ts`): frame + WinRT OCR + UIA walk → textual state | logs the focused window's state |
| FD.2 | Decision (`cu/decide.ts`): systemone per step + stall rules | decides correctly in a fixed scenario |
| FD.3 | Action (`cu/act.ts`): InvokePattern UIA preferred, SendInput/koffi fallback | opens a URL with the kill switch |
| FD.4 | Security: noul gate before mutation + physical kill + audit session | mutating action blocked by the gate |
| FD.5 | Voice/goal triggering + state overlay | 5-step script recorded |

Depends on E1–E2 ✅. FD.1 spikes can be pulled into Wave 1 if there's slack.

## Wave 5 — Jev Stage 5: multi-machine fabric + M4 polish · S/M · from 27/10

1. **voicecast MCP** (tools `sessions_list`/`session_get`/`sessions_search`/
   `latest_context`, designed in the original E3) accessible from note/macmini via
   SSH stdio (mcp-peer already registered both ways; `INFRA_MCP_LEVEL=ro`
   from outside).
2. CUA-Zcode × voicecast-loop coexistence policy documented + guardrail
   extended to the CUA surface.
3. s10deck as a peer (inventory; future remote capture).
4. **M4**: ASR hosting on linux/note (today only external via `VOICECAST_ASR_URLS`),
   external media import, WSL2 clock re-sync (infra).
5. Final gate: from the note, `sessions_search` on the pchome working in a real agent.

## Gantt view (dependencies)

```
Wave 0 (24/09) ─► Wave 1 cockpit (30/09) ─► Wave 4 E4 (24/10) ─► Wave 5 E5 (oct/nov)
                        │
                        └► Wave 2 product/dataset (03/10) ─► Wave 3 M3 (10/10)
⚡ OTel worker · hook/skill · CUA plugin · WASAPI: any time from Wave 1 on
```

Target date for "done" (M3+M4+E3+E4+E5+backlog): **end of October/2026** at the current
pace; early November with slack.

## Out of scope (reaffirmed from PLANO-JEV-CU)

Streaming/vision in Jev · dictation on macOS/Linux · replacing ZCode's CUA.
