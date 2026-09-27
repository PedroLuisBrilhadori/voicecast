# W1 — Worker thread para o import do SDK OTel · pronto

## Objetivo
Matar o residual do delay do REC: o import do SDK OTel trava o event loop do
main por ~9s; mover o init da telemetria para uma **worker_threads** (ou
utilityProcess, justifique a escolha) para o main nunca travar.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (regras + seção Telemetria)
- `/home/pedro/programing/projetos/voicecast/src/main/telemetry.ts` — init atual
  (espera idle+15s, retry 5s; `stopTelemetry` com flush no will-quit)
- `/home/pedro/programing/projetos/voicecast/src/shared/telemetry-core.ts` — core
  lazy (counters/histograms resolvem no primeiro emit)
- `/home/pedro/programing/projetos/voicecast/docs/RELATORIO-TELEMETRIA.md` —
  diagnóstico do delay (causa 2) e gotchas do SDK (metricReaders, flush,
  VOICECAST_OTEL_DEBUG)

## Escopo
**Fazer:**
- Inicializar o SDK OTel num worker separado; o processo main continua usando
  o core lazy (API in-memory) e o worker exporta (ponte: o mesmo OTLP HTTP
  endpoint `localhost:4318`; padrão messages do worker para lifecycle/erros).
- Se optar por utilityProcess em vez de worker_threads, justificar no briefing.
- Manter: kill-switch `OTEL_ENABLED=0`, diag `VOICECAST_OTEL_DEBUG=1`, flush no
  quit (o worker precisa ser encerrado COM flush — ver stopTelemetry atual).
- Telemetria sobre a telemetria (DoD): um log/counter de boot do worker
  (ex.: `voicecast_telemetry_worker_started_total` ou span) para sabermos que
  o caminho novo está vivo.

**Não tocar:** contrato dos instruments existentes (nomes/metricReader),
dashboards, capture/recorder, editor.

## Aceite verificável
- `pnpm ci:local` verde; testes novos: worker sobe e reporta pronto; init no
  main não bloqueia o event loop (teste de tempo com fake do SDK pesado —
  seguir padrão dos testes de telemetry existentes).
- `--autotest` continua funcionando (não é para quebrar o smoke existente).

## Riscos e gotchas
- O SDK no worker não compartilha processo com os emits do main — o design
  atual (core lazy no main + export no worker) precisa de uma ponte (ex.:
  PeriodicExportingMetricReader proxy via messages, OU mover TODO o core p/
  worker e o main só manda eventos). ESCOLHA o desenho mais simples que
  preserve os nomes Prometheus atuais e documente no briefing.
- app.exit() perde flush — o encerramento do worker precisa de graça (o
  relatório documenta o caso).

## Entrega
Commits convencionais, sem push. Preencher Resultado abaixo.

## Resultado (preenche o piloto)

**Entregue** (2026-09-27, piloto W1). O import do SDK OTel (~9s travando o
event loop do main) agora roda num **worker_threads**; o main nunca trava.

### Decisões de desenho (ambíguos do briefing, resolvidos e documentados)

1. **worker_threads, não utilityProcess.** O custo é import puro de módulos
   Node (CPU), sem nada de Chromium; spawn de thread é barato; as mensagens
   são minúsculas (structured clone resolve) e o worker não toca nenhuma API
   Electron. utilityProcess só adicionaria overhead de processo/IPC sem ganho
   para este caso.
2. **Core inteiro no worker; main só manda eventos** (2ª opção do briefing —
   não o proxy de `PeriodicExportingMetricReader`). Um reader-proxy exigiria
   código do SDK no main (reimport pesado) — derrota o objetivo. O worker
   reusa o MESMO `telemetry-core` lazy e cria os instruments com os
   **nomes/descrições que chegam nas mensagens** → nomes Prometheus intactos
   (`_total`, `_bucket/_sum/_count`, mesmo exporter/intervalo 5s/:4318).
3. **Hierarquia de spans preservada** (`session.start` → `recorder.load`/
   `recorder.open` existem hoje): `withSpan` no main mantém pilha de spans
   via `AsyncLocalStorage` e manda `span-start{id,parent,name,attrs,startMs}`
   / `span-end{id,endMs,error}`; o worker cria o span real com parent via
   `trace.setSpan` e timing epoch-ms (`TimeInput` aceita `Date.now()` —
   verificado no core 2.11).
4. **Semânticas mantidas**: emits antes do ready continuam descartados (como
   antes do init); `OTEL_ENABLED=0` verificada na ponte (nem spawn) e no
   worker (mensagem `disabled`); `VOICECAST_OTEL_DEBUG=1` liga o diag dentro
   do worker; `stopTelemetry` = mensagem `shutdown` → `sdk.shutdown()` (flush)
   → `shutdown-done` → terminate (timeout 10s — graça para o `app.exit()`,
   smokes `--autotest`/`--transcribe` continuam chamando antes de sair).

### Arquivos

- `src/shared/telemetry-protocol.ts` (novo) — contrato de mensagens.
- `src/shared/telemetry-worker.ts` (novo) — entry do worker: init real do SDK
  (movido 1:1 do telemetry.ts antigo) + core lazy + **boot counter**
  `voicecast_telemetry_worker_started_total` emitido pelo próprio worker no
  ready (DoD: telemetria sobre a telemetria — sai no flush do shutdown).
- `src/shared/telemetry-bridge.ts` (novo) — spawn/lifecycle/meter-ponte, puro
  Node (unit-testável; logging injetado).
- `src/main/telemetry.ts` — reescrito POR CIMA: API pública idêntica
  (`counter`/`histogram`/`withSpan`/`initTelemetry`/`stopTelemetry`); nenhum
  caller mudou (capture/library/jev/ditado/annotations/agent/index).
- `tests/telemetry-worker.test.ts` (novo) — 11 testes: protocolo com SDK
  injetado (boot counter, nomes/attrs, hierarquia/timing/erro de span, flush,
  kill-switch), ponte (kill-switch não spawna, degrada sem worker, emits em
  thread real), **init não bloqueia o event loop** (worker queima CPU 500ms;
  timers do main seguem pontuais — regressão do bug do W1) e **worker REAL**
  compilado via esbuild: sobe, importa o SDK de verdade e reporta pronto.

### Evidências

- `pnpm ci:local` verde (WSL): typecheck + **114 testes passed** (3 skipped =
  jev smoke condicional) + build; `dist/shared/telemetry-worker.js` gerado.
- Smoke do artefato de produção (`dist/shared/telemetry-worker.js` via
  worker_threads): `init` → `{"type":"ready","endpoint":"http://localhost:4318"}`
  → `shutdown` → `shutdown-done` (flush ok).
- `--autotest` intacto: `await initTelemetry()` continua no mesmo lugar
  (agora resolve no ready do worker, sem travar o loop).

### Achados (não consertados — fora do escopo)

- `src/main/index.ts` ainda agenda o init em idle+15s — mitigação histórica
  do block de 9s que ficou desnecessária (o worker torna o init seguro a
  qualquer momento; subir telemetria mais cedo = decisão da torre).
- Header do `src/shared/telemetry-core.ts` menciona "init 3s pós-ready" —
  descrição do desenho antigo; core intocado (contrato).

### Pendências

- Gate Windows pelo mantenedor (`pnpm dev:win`): confirmar que o import do
  SDK no worker não colide com o start do REC no mundo real (o objetivo do
  WP) e o counter `voicecast_telemetry_worker_started_total` chegando no
  Prometheus (dashboards intencionalmente intocados).
- Opcional futuro: encurtar/remover o wait de 15s do init (achado acima).
