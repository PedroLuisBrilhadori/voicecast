# Discovery 2026-09-21 — Jev + computer use + ZCode (probes and findings)

Discovery session (not closed). Context: integrating Jev (TypeSafe) consistently
into voicecast, porting the computer use approach to Windows, and plugging all
of it into ZCode as the main harness, at machine level (pchome-win, note,
macmini, s10deck). Picks up and continues the decisions from session
`sess_bc340fad-8535-4e68-a2c6-e71012a30136` (Migração do Opencode para Zcode —
the Opencode → ZCode migration), whose plan was written but never executed
(ExitPlanMode denied).

## Probes run (all PASSED)

### 1. Jev as the voicecast decision layer — `jev-systemone-voicecast.mjs`

A single `POST /v1/systemone` call with 4 questions (choice + 2×noul + score)
over a real voice+screen session transcript:

| Question | Result | Confidence |
|---|---|---|
| `rota_f9` (choice: ditado/comando_agente/anotação/conversa) | **comando_agente** | 0.98 |
| `pedido_de_acao` (noul) | 0.98 | — |
| `risco_da_acao` (noul: read-only?) | 0.97 | — |
| `relevancia_contexto` (score 0–3) | **2.92** (→ level 3) | 0.92 |

**741ms · 815 input + 120 output tokens · model jev-1.13.0.** Validated
pattern: F9/session → 1 call → route + risk gate + relevance score together.

⚠️ **Drift found in the local client**: `scripts/lib/jev-judge.ts` (workspace)
declares `type: "boolean"` — the API **only accepts `noul|choice|score`** (400
`api_usage_error`), noul.criteria is a `{true,false}` object, choice.criteria is
an option→description map, score.criteria is an ordered array. The local one
also has no `choice`. Official SDK: `@typesafe-ai/sdk@0.6.0` (npm, TS) /
`typesafe-sdk` (Python, 0.0.0). Official agent skill: `npx skills add typesafe-ai/skills`.

### 2. Native Windows OCR (WinRT) — `ocr-winrt.ps1`

`Windows.Media.Ocr` over `CopyFromScreen` of the primary screen, via WSL interop:

- capture 241ms (1920×1080) · **OCR 444ms** · pt-BR language pack already present
- read real on-screen text (ZCode window, including this task's own title)
- zero dependencies — the Apple Vision equivalent for the Windows port
- quirk: "Ctrl+N" → "CtrI+N" (I/l) — OCR complements UIA, it doesn't replace it

### 3. UIA tree of the foreground window — `uia-tree.ps1`

`System.Windows.Automation` over the ZCode window (Electron/Chromium):

- **381 ControlView nodes in 140ms** · 345 with name · **72 with InvokePattern**
- sample: Command palette, New task, `[Invoke]` buttons, task list
- ⇒ Electron exposes UIA without extra flags; InvokePattern = the AXPress equivalent
- remaining action: SendInput (precedent `voice/platform/win32.py`, port via
  koffi planned in VISION-V2)

Estimated cost per CU loop step (perception ~0.6s + Jev ~0.7s):
≈ **1.5s and <$0.0003** — in the ballpark of the macOS project (~$0.0002/step).

## Discovery map (confirmed by sources/probes)

- **Jev** = decision only (no computer use in TypeSafe; the API doesn't accept
  images). The viral Twitter project = **`awlevin/typesafe-computer-use`** (MIT,
  macOS): OCR+AX as structured text → Jev Choice decides → AXPress/click;
  the only platform adapter is `macos.py`; there is no Windows port.
- **The Windows port is not "porting from scratch"**: perception = desktopCapturer
  (already in voicecast) + WinRT OCR (probe 2) + UIA (probe 3); action =
  InvokePattern + SendInput. Voicecast hosts the loop (maintainer decision,
  sess_bc340fad).
- **ZCode**: OSS Apache-2.0 (github.com/zai-org/ZCode; Electron desktop with
  win build, server with remote WSL — current topology here is
  `desktop-attached-remote`). Official plugin **`computer-use` (0.6.3)** in the
  marketplace declares target `mac|windows|linux` — **in the cache but
  NOT enabled** on this machine (installed_plugins.json only has obsidian,
  video-agent-kit, mimosa). Two CU surfaces coexist: ZCode's CUA
  (agent-initiated, GLM) vs the voicecast+Jev loop (voice-initiated, cheap
  and deterministic) — complementary; the Jev gate can involve both.
- **Multi-machine fabric**: `mcp-peer.mjs` v1.3.0 (server-docs, stdio+SSH,
  JSONL→OTel telemetry, INFRA_MCP_LEVEL ro|rw) already runs as MCP `infra`/
  `pchome` in zcode.json. It's the multiplier: voicecast context + Jev
  decisions + CU reachable from note/macmini (+future s10deck).

## Open fronts (next spikes)

1. Install the `computer-use` plugin in ZCode Desktop (marketplace UI) and prove
   `computer.target` in the desktop-attached-remote topology (Windows host vs WSLg).
2. Voice→ZCode injection: OSS headless CLI (`apps/zcode-cli`, print/exec flag
   unverified) vs UserPromptSubmit hook vs skill/slash. No Windows CLI
   installed today (only ZCode.exe Desktop).
3. Consolidate the Jev client (rewritten FJ milestone): canonical `jev-judge`
   with correct choice + criteria, adoption of the official SDK, unify
   guardrail/qa.
4. Voicecast MCP (sessions_search/transcript/clip) + transport via the
   mcp-peer pattern for agents on the other machines.
5. s10deck as a fabric node (SSH/Termux peer?).

## How to re-run

```bash
# Jev (needs TYPESAFE_API_KEY in the workspace root .env)
node voicecast/scripts/probes/2026-09-21-discovery/jev-systemone-voicecast.mjs
# OCR + UIA (Windows host, from WSL)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File voicecast/scripts/probes/2026-09-21-discovery/ocr-winrt.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File voicecast/scripts/probes/2026-09-21-discovery/uia-tree.ps1
```
