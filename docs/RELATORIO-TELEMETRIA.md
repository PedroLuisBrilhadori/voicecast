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

## Validação (real, Windows + Grafana — 2026-09-23)

- WSL: `pnpm ci:local` ok (typecheck + 61 testes + build), incluindo os novos
  testes do telemetry-core; queries do dashboard validadas na API do Grafana.
- **Prometheus recebeu as métricas do app**: `voicecast_sessions_total` = 1,
  `voicecast_session_starts_total` = 1, `voicecast_session_start_seconds_count`
  = 3 (estágios total/gum-desktop/gum-mic) após `--autotest`; collector com
  delta positivo e **zero falhas novas**.
- **Breakdown real do start (quente)**: total **1,18s** · gum-desktop **0,27s**
  · gum-mic **0,26s** — a captura é rápida; o delay de 8–10s relatado tinha
  OUTRA causa (abaixo).
- Traces `session.start`/`recorder.load`/`recorder.open`/`sources.list` no
  Tempo (service `voicecast`).
- **Checagem visual do dashboard** (painéis/legendas/units) pendente do
  mantenedor: http://localhost:3001/d/voicecast.

## Descobertas do diagnóstico (o "delay" tinha dois andares)

1. **Barra depois da captura** (fixado na F1): a barra só nascia após o
   getUserMedia — agora nasce na hora ("preparando captura…").
2. **Import do SDK OTel trava o event loop por ~9s**: medido no autotest de
   cold start (`start ok: total=9.97s` com desktop=218ms/mic=221ms — o
   `telemetria: OTLP para` só terminou DEPOIS de 9s, colidindo com o start).
   Mitigação: init do OTel agora espera **idle + 15s de vida** (retry 5s);
   o `--autotest` inicializa a telemetria ANTES de medir (caminho estável).
   Residual: gravação iniciada nos ~9s em que o import roda ainda colide —
   fix definitivo futuro = import do SDK em worker thread.
3. **Infra (unidocs)**: o remotewrite do collector descartava lotes inteiros
   com `out of order sample` **desde 2026-09-19** (~98k pontos no acumulado) —
   produtores com relógio à frente (Windows: skew medido de ~2,2s do WSL2) e
   replays de fila. Fix: Prometheus `v3.0.1 → v3.13.3` +
   `storage.tsdb.out_of_order_time_window: 10m` (a config não existe no
   v3.0.1; no v3 virou chave de config, não flag de CLI). Sonda OTLP→collector
   →Prometheus validada antes/depois.
4. **App saía sem flush**: o reader só exporta a cada 5s e o `app.exit()`
   dos smokes perdia o ciclo — `stopTelemetry()` (shutdown+flush) no
   will-quit e nos ganchos que saem. Detecção de erros de export:
   `VOICECAST_OTEL_DEBUG=1` (diag logger, silencioso por default).

## Notas

- Emits antes do init (idle ≥15s) são descartados por design — janela
  pequena, documentada no telemetry-core.
- Nomes Prometheus: counters com `_total`, histogramas geram
  `_bucket/_sum/_count` — validado ponta a ponta.
- Próximos blocos (fora do escopo): ditado-start/ASR host/boot/erros globais/
  `clip_seconds`; logs → Loki (handler OTLP); worker thread p/ o import do
  SDK; re-sync de relógio do WSL2 (hwclock) na infra.
