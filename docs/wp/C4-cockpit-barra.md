# C4 — Cockpit v1 na barra (utilityProcess + IPC) · bloqueado por C2-unlock (U1)

## Objetivo
O mantenedor vê o ciclo do goal na barra do voicecast: `ouvindo → roteando →
rodando → concluído | erro`, com o resultado aparecendo no fim. Bridge roda
em utilityProcess (decisão ratificada): crash dele não derruba gravação/ditado.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-COCKPIT.md` (C2/C4 + decisões)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` —
  runGoal/GoalQueue (o worker vai hospedar ESSA lógica; não duplicar)
- `/home/pedro/programing/projetos/voicecast/src/shared/agent-goal.ts` —
  máquina de estados pura (a barra consome GoalState)
- `/home/pedro/programing/projetos/voicecast/src/main/index.ts` + `src/shared/ipc.ts`
  + `src/preload/index.ts` — padrão de registro IPC/broadcast da casa
- `/home/pedro/programing/projetos/voicecast/src/renderer/BarApp.tsx` — onde os
  estados aparecem (seguir padrão do `ditado-state`)
- `/home/pedro/programing/projetos/voicecast/vite.config.ts` + `package.json` —
  build (main é tsc→CJS; worker precisa ser entry próprio compilado)

## Escopo
**Fazer:**
1. `src/main/agent/worker.ts` — entry do utilityProcess: recebe
   `{type:"enqueue", req}` / `{type:"status"}` pela MessagePort, hospeda
   GoalQueue, responde `{type:"goal-state", state}` a cada transição.
2. `src/main/agent/bridge.ts` — utilityProcess.fork do worker (path do dist),
   fila/cleanup no quit, kill-switch `VOICECAST_AGENT_BRIDGE=0` também no
   nível do fork. Se o fork não for viável na estrutura de build atual,
   DOCUMENTE o motivo e proponha alternativa (não improvisar build novo).
3. IPC: canais novos em `src/shared/ipc.ts` (`agentRunGoal`, `agentGetState`,
   evento broadcast `agent-state` via CaptureEvent ou canal dedicado — siga o
   padrão existente) + preload + handlers no main + teste no
   ipc-contract.test.ts (contrato é lei).
4. BarApp: linha de estado do goal (mesma linguagem visual do `ditado-state`);
   entrada digitada opcional no painel (voz entra depois — F9 já roteia).
5. Telemetria (DoD): a do runner já existe (goals/seconds); adicionar counter
   `voicecast_agent_bridge_messages_total{direcao}` para a ponte main↔worker.

**Não tocar:** captura/gravação, ditado, editor, gate de permissão (C5 é
depois), protocolo do zcode-server (fora de escopo).

## Aceite verificável
- `pnpm ci:local` verde; teste novo do worker com utilityProcess MOCK (port de
  messages fake) validando o protocolo de mensagens; teste do contrato IPC.
- `--agenttest "goal de teste"`: gancho determinístico novo no estilo
  `--autotest` (grava no main/index.ts): enfileira goal no bridge, imprime
  estados no stdout e sai. Roda no Windows (validação do mantenedor), mas o
  código e o smoke do protocolo ficam verdes no WSL.

## Riscos e gotchas
- utilityProcess usa um entry JS compilado — conferir que `tsc -p
  tsconfig.node.json` produz `dist/main/agent/worker.js` importável pelo fork
  (path relativo ao dist/main — ver como o main atual resolve paths no build).
- OTel no worker: telemetria do runner já emite do processo que roda
  runGoal — ao mover para o worker, os emits migram juntos (core lazy é por
  processo; confirmar init do SDK no worker ou aceitar spans ausentes e
  documentar — NÃO duplicar init do SDK em dois processos sem checar o
  collector).
- A barra é sempre-on-top e pequena: uma linha de estado, sem notificação
  intrusiva.

## Entrega
Commits convencionais, sem push. Preencher Resultado abaixo.

## Resultado (preenche o piloto)

**Entregue (2026-09-27)** — commits `37ee380`, `a54b22f`, `b69e7a3` (+ docs).
`pnpm ci:local` verde: typecheck ×2 · **176 testes** (7 novos do worker com
porta MOCK + 2 novos no ipc-contract) · build produz `dist/main/agent/worker.js`
(CJS, sibling do bridge.js — fork resolve por `__dirname`, sem mudança de build).

**Decisões com evidência (fora do caminho óbvio do briefing):**

1. **Enricher C3 roda NO MAIN, não no worker** — medido empiricamente no
   Electron 44 (smoke xvfb): dentro do utilityProcess `require("electron")`
   devolve **apenas `{net, systemPreferences}`** — não há `app`. A cadeia do
   `goalContextEnricher()` (biblioteca → storage → `app.getPath("userData")`)
   não roda lá. O worker hospeda o GoalQueue com um **delegante pela porta**
   (`enrich-request`/`enrich-result`, fail-soft por timeout de 30s — mesma
   semântica C3); o main responde com o `goalContextEnricher()` de produção.
   O counter `voicecast_agent_context_total` então segue emitindo no main.
2. **Telemetria do runner migra com a fila SEM duplicar SDK** — o utilityProcess
   não inicializa SDK OTel (regra do briefing). O worker pluga um **meter-ponte**
   (`setProcessMeter`, export novo e mínimo no `telemetry.ts`) que retransmite
   counter/histogram pela porta (`{type:"telemetry"}`); o bridge os reemite na
   telemetria do main com os **mesmos nomes** (`voicecast_agent_goals_total`,
   `voicecast_agent_goal_seconds`, counter do runtime setup) — um único
   SDK/exporter (worker-thread do W1), sem colisão no collector. **Spans do
   `agent.goal` ficam ausentes no worker** (withSpan não atravessa a porta) —
   aceito e documentado conforme o briefing.
3. **Recusa de enqueue vira estado sintético `failed`** (goal vazio / bridge
   off) — a barra mostra o POR QUÊ, sem novo tipo de mensagem no protocolo.

**Escopo entregue:** worker + protocolo puro (`agent-worker-protocol.ts`) ·
bridge (fork lazy com refork pós-crash, kill-switch duplo — nível do fork E do
runner — cleanup no will-quit, counter `voicecast_agent_bridge_messages_total{direcao}`)
· IPC `agent:run-goal`/`agent:get-state` + evento broadcast `agent-state` no
`CaptureEvent` (padrão da casa) + preload + teste de contrato · BarApp com linha
de estado do goal (linguagem visual do `ditado-state`, desfecho some em 6s) ·
entrada digitada no painel (App.tsx, Ctrl+F9) · gancho `--agenttest "goal"`
(determinístico com `ZCODE_AGENT_BIN` fake; imprime estados no stdout, exit
0 = completed).

**Smoke E2E real no WSL (além dos mocks, xvfb + Electron):** fork do
utilityProcess → worker → GoalQueue → fake-agent.sh → `queued → running →
completed` de volta pela porta, com round-trip de enrich respondido; kill-switch
`VOICECAST_AGENT_BRIDGE=0` bloqueia no fork (`ok:false`).

**Achados (não consertados — fora do escopo):** o runner ignora `req.cwd` no
Windows (spawn via `wsl.exe` sem cwd — comportamento do C2); o `goalSummary`
duplicado em `runner.ts` e `agent-goal.ts` (o do runner não é usado pelo C4 —
o puro da shared é o consumido).

**Pendências p/ gate Windows (mantenedor):** rodar `pnpm dev:win` +
`voicecast.exe --agenttest "Responda somente: ok"` (runtime C2b real — valida
spawn wsl.exe, estados na barra e telemetria no Grafana: counters
`voicecast_agent_bridge_messages_total`, `voicecast_agent_goals_total`,
`voicecast_agent_context_total`); validar entrada digitada no painel.
