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
- (pendente)
