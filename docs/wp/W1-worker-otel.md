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
- (pendente)
