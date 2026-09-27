# Probe ACP — protocolo stdio do zcode-server (C1 do PLANO-COCKPIT)

Data: 2026-09-27 · Probe: `probe-acp.mjs` (transcript em `probe-log.jsonl`)
Alvo: `~/.zcode/server/zcode-server.cjs` (v3.14.3, linux/x64) — o MESMO binary
que o ZCode Desktop dirige hoje (pid observado em produção).

## O que foi provado

1. **O server aceita clientes próprios**: spawn limpo, handshake aceito com
   `clientId: voicecast-probe` ("client connected"), boot até "stdio mode
   ready" em ~2s, Provider Registry pronto (3 providers), plano de billing
   detectado (conta compartilhada com o Desktop — goals rodam no plano real).
2. **Handshake (ndjson, primeiro par de linhas)**:
   - Server → cliente: `{"type":"zcode-hello","version":"3.14.3","platform":"linux","arch":"x64","pid":N}`
   - Cliente → server: `{"type":"zcode-hello-ack","version":"<string>","clientId":"<não-vazio>"}`
   - Sem ack válido o server MORRE com erro zod preciso (schemas:
     `helloMessageSchema`/`helloAckMessageSchema`).
3. **Depois do handshake o canal vira binário** (VS Code Protocol): cada
   mensagem = header de **13 bytes** + payload:
   `[type:u8=1][id:u32BE][ack:u32BE][length:u32BE]` + `length` bytes de corpo.
   (Foi por isso que requests ndjson pós-ack foram engolidos em silêncio.)
4. **Payload = vscode-rpc** (a lib pública do npm — classes `ChannelServer`,
   `ProxyChannel`, `BufferWriter/Reader` batem 1:1 com o bundle):
   - corpo = 2 valores serializados (header array + body) pelo serializer
     enum-tagado da lib (`4=Array, 5=Object, 3=VSBuffer…`)
   - request: `[100, id, channelName, methodName]` + arg
   - event-listen: `[102, id, channelName, eventName]` + arg
   - respostas: `[200]` (init) · `[201, id]`+data (sucesso) · `[202, id]`+err ·
     `[204, id]`+data (event fire)
5. **Canais expostos** (`ServiceChannels`): `file`, `system`, `terminal`,
   `git`, `git-checkpoint`, `setting`, `credential`, `cua-permission`,
   `cua-pip-session`, `broadcast`, `zcode-task`, `window-controller`, e o
   serviço de agente (ZCode Protocol agent). Métodos prováveis do caminho v4:
   **`createSession`** (42 refs no bundle; comentários: "V4 createSession é o
   caminho real de criação") e **`sendText`** ("send 主路径已收敛 v4 sendText").
   `session/send`/`session/stop` estão **deprecated** no wire.
6. Superfície v4 adicional mapeada (strings): `v4/connection/flow`,
   `v4/controller/subscribe`, `v4/conversation/subscribe|frame|fileChanges`,
   `v4/attachment/*`, `v4/commands/query`.

## Consequência para o C2 (bridge)

- **Não reimplementar o protocolo**: usar o pacote npm `vscode-rpc`
  (`ChannelClient`) sobre o stdio do spawn — mesmo vocabulário do server.
- Sequência do bridge: spawn → `zcode-hello-ack` → `ChannelClient` →
  `getChannel(<agent>).call("createSession", {cwd…})` → `sendText` →
  events (`turn.*`/`session.event`) → desfecho.
- Do Windows o spawn atravessa `wsl.exe -e` (pipes preservados — mesmo
  mecanismo da ponte do Desktop).
- Custo: cada goal roda no plano ZAI real (server consulta billing no boot).

## O que falta no C1 (uma iteração)

Roundtrip final com `vscode-rpc`: nome exato do canal do agente + args de
`createSession`/`sendText` + nome do evento de turno (validar empiricamente;
tudo já reduzido a essas três incógnitas). Transcript completo no
`probe-log.jsonl`.
