# RELATORIO-TELEMETRIA — OTel funcional + fix do delay do REC (2026-09-22)

Marco: telemetria OTel do voicecast **realmente funcionando** (as métricas
existiam no código mas nenhuma chegava ao Grafana) + instrumentação do
pipeline de start + fix do delay percebido entre o pedido de gravação e a
barra REC.

## Contexto e achado

- `src/main/telemetry.ts` declarava 7 counters/histograms no **module-load**,
  mas o init do SDK OTel é tardio (`index.ts`, 3s pós-ready, pra não travar o
  probe do daemon F9). Com o meter ainda `null`, as factories devolviam `null`
  e **todas as métricas ficavam inertes para sempre** — só 2 spans
  (`session.finalize`, `ditado.stop`) eram emitidos de fato.
- O pipeline de **start** não tinha instrumentação nenhuma — é onde morava o
  delay reportado pelo mantenedor (barra REC aparecendo com ~8–10s no timer).
  Causa: `startBar()` só rodava DEPOIS do `getUserMedia` de tela + mic
  (sequencial, segundos no Windows), e o timer contava desde `startedAt`
  (fixado antes do warm-up). Ou seja: o relógio mostrava tempo que o vídeo
  nem tinha.

## O que mudou

### F0 — métricas vivas

- **`src/shared/telemetry-core.ts` (novo, puro)**: registro lazy — o
  instrumento é resolvido no primeiro `add/record` com o meter pós-init e
  cacheado por nome (declaração duplicada cai no mesmo instrumento). Emit
  antes do init é descartado sem lançar.
- `src/main/telemetry.ts`: factories agora vêm do core; init injeita o meter
  real (`core.setMeter`). Kill-switch `OTEL_ENABLED=0` e
  `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`) mantidos.
- Dedupe: `voicecast_sessions_total` ficou só no `capture.ts` (a declaração
  órfã em `library.ts` saiu).
- Testes: `tests/telemetry.test.ts` (antes do init não lança; pós-init grava;
  cache por nome; `setMeter(null)` degrada).

### F1 — start instrumentado + barra imediata (fix do delay)

- **Barra REC nasce na hora**: `startRecording` cria a barra e o preview
  ANTES do warm-up da captura. Estado novo `RecordingState.arming` — a barra
  mostra "⏳ preparando captura…" e trava marker/pause/parar (stop durante
  arming = cancelamento limpo).
- **Relógio verdadeiro**: o recorder (`recorder.ts`) devolve `startedAtReal`
  (o `Date.now()` do `recorder.start()`) e o main adota — timer, `durationS`
  do `meta.json` e markers passam a casar com o conteúdo do mp4 (e com a
  transcrição).
- **Métricas/spans novos**:
  - `voicecast_session_starts_total{mode,outcome=ok|erro}` (counter)
  - `voicecast_session_start_seconds{mode,stage=total|gum-desktop|gum-mic}`
    (histograma — separa o custo do `getUserMedia` de tela vs mic)
  - spans `session.start` (com filhos `recorder.load`, `recorder.open`) e
    `sources.list` (fluxo tela-cheia lista fontes antes de gravar).
- Breakdown do start também no log: `start ok: total=…s (desktop=…ms mic=…ms)`.

### F3 — dashboard Grafana

- `unidocs/volumes/grafana/dashboards-json/voicecast.json` (uid `voicecast`,
  commit no repo unidocs — provider de arquivo, mesma casa dos dashboards
  `agentes-*`/`voice-*`): sessões por modo, inícios por desfecho,
  **start p50/p95 (o painel do delay)** + média por estágio, finalize p50/p95,
  ASR p50/p95 e por status, ditados, decisões Jev, eventos/prints de anotação.
- Fluxo de dados: voicecast (Windows) → OTLP HTTP `localhost:4318` (collector
  do `pnpm docker:observability` do unidocs) → Prometheus/Tempo → Grafana
  `localhost:3001`.

## Validação

- WSL: `pnpm ci:local` ok (typecheck + 61 testes + build), incluindo os novos
  testes do telemetry-core; queries representativas do dashboard validadas na
  API do Grafana (`/api/ds/query` — sintaxe ok, frames vazios sem dados).
- Dashboard provisionado e visível no Grafana local (uid `voicecast`) sem
  restart.
- **Pendente (Windows, com o mantenedor)**: `pnpm dev:win` → `--autotest` →
  conferir no Grafana `voicecast_sessions_total` subindo, histograma de start
  com dados e traces `session.start` no Tempo; na mão, `Ctrl+Shift+F9` deve
  mostrar a barra instantânea com "preparando captura…" e o timer começando
  ~0 no REC. Baseline do delay: percepção do mantenedor (8–10s) — números
  reais passam a ficar no painel.

## Notas

- Emits nos primeiros ~3s de vida do app (antes do init) são descartados por
  design — janela pequena, documentada no telemetry-core.
- Nomes Prometheus: counters com sufixo `_total` mantidos; histogramas geram
  `_bucket/_sum/_count` via remotewrite. Se o collector fizer sanitização
  diferente na validação real, ajustar as queries do painel (não o código).
- Fora do escopo deste marco (próximos blocos): ditado-start/ASR host/boot/
  erros globais/`clip_seconds`; logs → Loki (handler OTLP, paridade voice).
