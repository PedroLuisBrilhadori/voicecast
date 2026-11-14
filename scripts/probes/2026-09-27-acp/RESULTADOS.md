# Probe ACP — zcode-server stdio protocol (C1 of PLANO-COCKPIT)

Date: 2026-09-27 · Probes: `probe-acp.mjs` + `probe-roundtrip.mjs`
(transcripts in `probe-log.jsonl` / `roundtrip-log.jsonl`)
Target: `~/.zcode/server/zcode-server.cjs` (v3.14.3, linux/x64) — the SAME binary
the ZCode Desktop drives today (pid observed in production).

## Roundtrip addendum (same date) — findings that changed C2

1. `createSession {workspacePath}` (`zcode-agent` channel, args as positional
   ARRAY) reaches the server and it goes FAR: resolves the workspace, spawns the
   **nested agent** `~/.zcode/server/agents/glm/zcode-agent app-server
   --stdio --surface desktop` (ndjson JSON-RPC), delivers provider config.
2. Right after, the **agent asks `session/requestRuntimePreferences` back
   from the parent** — and whoever answers is the **desktop authority**
   (`serviceAuthorityMode: desktop-attached-remote`). No desktop connected →
   15s timeout → `createSession` fails.
3. The agent CLI exposes a **first-class headless mode**: `-p/--prompt`,
   `--surface terminal|desktop`, `--attach`, `--resume`, `--mode
   build|edit|plan|yolo` (default yolo in -p), `--cwd`, `--json`, `-c`.
   Shared credentials `~/.zcode/v2/credentials.json`.
4. Single blocker of headless: "Select a model before continuing" — selection
   lives in the sessions db (`session_entry`, key `runtime/model_selection`,
   id `<session>:runtime-model-selection`); via TUI the desktop selects it,
   headless has no documented flag. Pending: official selection path.
5. **Conclusion**: bridge v1 = direct headless CLI (no middleman). The
   binary-channel knowledge stays on record for E5/fabric and future
   integrations (permission gating etc.).

## Addendum 2 — open source (zai-org/zcode repo, 2026-09-27)

The harness is open source (github.com/zai-org/zcode, MIT). The source code
settled model selection definitively:

- `defaultModelSelection` is a **field of the personal provider_config.json**
  (`config.defaultModelSelection = {providerId, modelId, options?}` — strict
  codec, schemaVersion 1). It's what the TUI persists via
  `saveConfiguredDefault` when picking a model.
- On `main`, the headless boot reads that default
  (`configuredDefaultModelSelection`) and even has a **registry fallback**
  (first visible model) for new drafts — `resolveInitialModelSelection`
  in packages/provider/src/model-selection-config.ts.
- `account:*` providers are **synthesized from credentials** (standalone
  account service) — they don't come from the builtin; the builtin defines
  templates.
- The complete builtin is EMBEDDED in the server (string in the bundle) —
  extracted to `/tmp/zcode-builtin-provider.json` (revision 30, 20 templates);
  envs `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` point to the paths.

**Unlock state at end of turn**: the installed CLI (0.16.9) contains the
default repository but full consumption in `-p` (default→runtime +
fallback) is on main — version drift. We wrote
`defaultModelSelection` to the personal file (backup
`provider_config.json.bak-voicecast`) and tested with the envs: still
"Select a model". Unlock paths, in order of preference:

1. **Build the CLI from the repo** (main) and use that binary in the bridge —
   native open-source path, removes the drift; the bridge already
   parameterizes the binary via `ZCODE_AGENT_BIN`.
2. Check whether an official CLI update (>0.16.9) already ships the wiring.
3. Validate whether selecting a model once in the TUI persists the default
   (0.16.9) and unlocks headless — likely, to be tested.

The rest of this document records the original decoding of the binary
protocol (handshake, framing, serializer, channels, v4 schemas) — still
correct and useful; it's just not the bridge v1 path.

## What was proven (original roundtrip, before the pivot)

1. **The server accepts its own clients**: clean spawn, handshake accepted with
   `clientId: voicecast-probe` ("client connected"), boot to "stdio mode
   ready" in ~2s, Provider Registry ready (3 providers), billing plan
   detected (account shared with the Desktop — goals run on the real plan).
2. **Handshake (ndjson, first pair of lines)**:
   - Server → client: `{"type":"zcode-hello","version":"3.14.3","platform":"linux","arch":"x64","pid":N}`
   - Client → server: `{"type":"zcode-hello-ack","version":"<string>","clientId":"<non-empty>"}`
   - Without a valid ack the server DIES with a precise zod error (schemas:
     `helloMessageSchema`/`helloAckMessageSchema`).
3. **After the handshake the channel turns binary** (VS Code Protocol): each
   message = **13-byte** header + payload:
   `[type:u8=1][id:u32BE][ack:u32BE][length:u32BE]` + `length` body bytes.
   (That's why post-ack ndjson requests were silently swallowed.)
4. **Payload = vscode-rpc** (the public npm lib — `ChannelServer`,
   `ProxyChannel`, `BufferWriter/Reader` classes match the bundle 1:1):
   - body = 2 serialized values (header array + body) by the lib's
     enum-tagged serializer (`4=Array, 5=Object, 3=VSBuffer…`)
   - request: `[100, id, channelName, methodName]` + arg
   - event-listen: `[102, id, channelName, eventName]` + arg
   - responses: `[200]` (init) · `[201, id]`+data (success) · `[202, id]`+err ·
     `[204, id]`+data (event fire)
5. **Exposed channels** (`ServiceChannels`): `file`, `system`, `terminal`,
   `git`, `git-checkpoint`, `setting`, `credential`, `cua-permission`,
   `cua-pip-session`, `broadcast`, `zcode-task`, `window-controller`, plus the
   agent service (ZCode Protocol agent). Likely v4-path methods:
   **`createSession`** (42 refs in the bundle; comments: "V4 createSession é o
   caminho real de criação" [V4 createSession is the real creation path]) and
   **`sendText`** ("send 主路径已收敛 v4 sendText" [main path converged to v4 sendText]).
   `session/send`/`session/stop` are **deprecated** on the wire.
6. Additional v4 surface mapped (strings): `v4/connection/flow`,
   `v4/controller/subscribe`, `v4/conversation/subscribe|frame|fileChanges`,
   `v4/attachment/*`, `v4/commands/query`.

## Consequence for C2 (bridge)

- **Don't reimplement the protocol**: use the npm package `vscode-rpc`
  (`ChannelClient`) over the spawn's stdio — same vocabulary as the server.
- Bridge sequence: spawn → `zcode-hello-ack` → `ChannelClient` →
  `getChannel(<agent>).call("createSession", {cwd…})` → `sendText` →
  events (`turn.*`/`session.event`) → outcome.
- From Windows the spawn goes through `wsl.exe -e` (pipes preserved — same
  mechanism as the Desktop bridge).
- Cost: each goal runs on the real ZAI plan (server queries billing at boot).

## C1 unknowns — RESOLVED (2026-09-27, same session)

1. **Agent channel**: `zcode-agent` (useful siblings: `zcode-session`,
   `conversation-share`; others: `file/system/terminal/git/setting/
   credential/cua-*/broadcast/zcode-task/window-controller`).
2. **Args of the v4 commands** (zod schemas extracted from the bundle):
   - `createSession`: `{ workspaceId: string, firstInput?: { text, attachments?,
     modelSelection?, mode?, planEnabled? }, config?, mcpServers?,
     offPeakToolEnabled?, dynamicWorkflowEnabled? }` — **creates the session and fires
     the goal in the same command** (`firstInput.text`); no firstInput = draft session.
   - `sendText`: envelope `{type:"sendText", sessionId, payload}` with payload
     `{ text, attachments?, requestedDelivery?: "startNow"|"queue"|"guide",
     browserAmbientContext?, context_refs? (≤1), heldQueueDisposition? }` —
     command with ACK (`assertV4CommandAckOk`).
   - There is ALSO a service-level createSession that accepts
     `workspacePath` (direct layer) — the `cwd → workspaceId` mapping stays
     as a C2 implementation detail.
3. **Session events** (complete registry from the bundle): `session.titleUpdated/
   closed`, `turn.started/steerQueued/steerDrained/completed/failed`
   (`turn.completed` carries `duration` + `cacheStats`), `message.upserted/
   removed`, `part.started/delta/upserted/removed`, `model.streaming`,
   `tool.updated`, **`permission.requested/resolved`** (hook of the C5 gate),
   `userInput.requested/resolved`.

Single residual for C2: resolve `workspaceId` from the chosen cwd
(likely: workspace service or service-level createSession with
`workspacePath`).

## What used to be the previous section (context)
