# AGENTS.md — voicecast

App desktop Electron de sessões de contexto (voz + tela → transcrição →
referências para agentes). Guia para agentes de código trabalhando neste repo.

## Regras do repo

- Código/app vive AQUI (repo próprio); nada de código de app na raiz do
  workspace `projetos/`.
- **Convenção dois ambientes** (padrão voice-dictation): o repo roda no WSL
  (typecheck/testes/build); a execução com captura real acontece na cópia do
  Windows (`%LOCALAPPDATA%\voicecast\src`, sincronizada por
  `scripts/sync-to-host.ps1`). NUNCA instalar node_modules do Windows dentro
  do repo do WSL.

## Mapa

| Path | Papel |
|---|---|
| `docs/DELEGACAO.md` | **Protocolo de WPs pilotados por subagents** + estado dos WPs + briefings em `docs/wp/` — agente delegado começa por aqui |

| Path | Papel |
|---|---|
| `src/shared/ipc.ts` | Contrato IPC tipado — canais + payloads. Mudou aqui → muda preload + renderer + testes |
| `src/shared/paths.ts` | Helpers puros (WSL path, nomes de sessão) — testáveis |
| `src/main/` | Processo principal: janelas, atalhos globais, captura, ffmpeg, storage |
| `src/main/storage.ts` | Único lugar que monta path de dados (`%LOCALAPPDATA%\voicecast`) |
| `asr-backend/` | Serviço ASR python vendorizado (faster-whisper/FastAPI) — subset do voice; patch `VOICE_APP_DIR` no `platform/common.py` |
| `src/main/asr-host.ts` | Supervisor do backend: spawn + health + respawn (lógica pura em `src/shared/asr-host-logic.ts`) |
| `src/main/jev.ts` | Jev (TypeSafe) no app — julgamento fail-soft do F9 e da sessão (Etapa 2 do PLANO-JEV-CU) |
| `src/main/jev-questions.ts` | Perguntas/limiares Jev — arquivo único revisável; não editar sem rodar o smoke |
| `src/shared/annotations.ts` | Motor PURO das anotações (fold do log, undo/redo, borracha 2 modos) — sem electron |
| `src/shared/segments.ts` | Motor PURO dos segmentos do editor fase B (sanitize, nomes de clipe/corte, fatia de transcrição) — sem electron |
| `src/main/annotations.ts` | Engine das anotações: overlay, hotkeys, jsonl, auto-print (D7), marker queimado (D6) |
| `src/preload/` | Ponte contextBridge — só expõe o contrato |
| `src/renderer/` | React 19 (picker, overlay de região, barra REC, editor, biblioteca) |
| `tests/` | Vitest (contrato, paths, storage, jev) |
| `scripts/` | sync-to-host.ps1 / run-win.ps1 (dev loop Windows; sync reinstala deps quando o package.json muda) |
| `docs/` | Relatórios de marco (F0, decisões) |

## Convenções

- Atalhos globais definidos na F0: `Ctrl+F9` painel, `Ctrl+Shift+F9` tela cheia.
- Gravação: MediaRecorder → `original.fmp4` → remux `-c copy -movflags +faststart`
  → `session.mp4` (fMP4 vem sem duração; remux é OBRIGATÓRIO no stop).
- Metas: `meta.json` com status `draft` gravado ANTES de começar a gravar,
  promovido a `finalizada` no stop (crash-safe, padrão voice-11).
- Handoff para agentes: prints + clipes + transcript (o `Read` do agente tem
  limite de 30MB — vídeo cru longo não é entregável).
- Coordenadas de região/janela em **px físicos** (tela está em scale 1.53).
- ASR: cliente HTTP `:8701` com failover de URLs (src/main/asr.ts) **e host do
  serviço** — `src/main/asr-host.ts` spawna/supervisiona o python vendorizado
  em `asr-backend/` (instalação: `scripts/setup-asr-backend.ps1`, dados em
  `%LOCALAPPDATA%\voicecast\asr-backend`, log em `logs/asr-backend.log`).
  Nunca duplica serviço que já responde na porta. Kill-switch:
  `VOICECAST_ASR_HOST=0`; com `VOICECAST_ASR_URLS`/`VOICE_ASR_URLS`
  configurado, usa o externo e não hospeda.
- **Jev (Etapa 2)**: F9 roteia a intenção ANTES de colar — comando pro agente,
  anotação e conversa (conf ≥ 0.9) NÃO são colados na janela focada; a barra
  mostra o desfecho. Sessão finalizada ganha `meta.json.jev` (rota, relevância,
  pedido, risco) e o `buildContext` inclui a linha de julgamento. **Fail-soft**:
  sem key/erro → tudo se comporta como antes. Key: env `TYPESAFE_API_KEY` ou
  `%APPDATA%\voicecast\jev-key.txt` (1 linha). Kill-switch: `VOICECAST_JEV=0`.
  Smoke (API real, sob pedido):
  `VOICECAST_JEV_SMOKE=1 TYPESAFE_API_KEY=<key> pnpm vitest run tests/jev.smoke.test.ts`.
- Ganchos de teste no app real (sem tecla física): `--ditado-test`
  (F9 start→6s→stop; determinístico com `VOICECAST_DITADO_FAKE_TEXT`) e
  `--autotest` (grava 8s e sai) + `--transcribe=DIR/NOME` (transcreve+julga e
  sai) + `--agenttest "goal"` (C4/cockpit: enfileira o goal na ponte do
  utilityProcess, imprime os estados no stdout e sai — exit 0 = completed;
  determinístico com `ZCODE_AGENT_BIN` apontando um agente fake).
  Rotina de validação no Windows documentada em docs/RELATORIO-E2.md.
- **Anotações em tela (AN — PLANO-ANOTACOES-TELA)**: durante REC e no ditado,
  overlay transparente com laser/pincel/borracha. Log vetorial
  `annotations.jsonl` por sessão (px físicos, t relativo — fonte da verdade;
  motor puro em `src/shared/annotations.ts`). Hotkeys `Ctrl+Alt+L/B/E/C`
  ferramentas, `Ctrl+Alt+C` ou `Ctrl+Alt+X` limpar tudo, `Ctrl+Alt+Espaço` desenho↔pass-through, `Ctrl+Alt+P` print.
  `Ctrl+Alt+H` é global do app: sem painel aberto, abre o painel standalone
  (fora de sessão, com botão `✕ fechar` que descarta o rascunho); com painel,
  oculta/mostra a paleta. **Paleta sob demanda (2026-09-23)**: REC/ditado NÃO
  abrem mais a paleta (oculta por default; `Ctrl+Alt+H` mostra) — a overlay
  segue viva em pass-through, então prints (D6/D7/Ctrl+Alt+P) e hotkeys
  funcionam sem ela. Gravação/ditado iniciados com o painel standalone
  aberto o ADOTAM (overlay e traços preservados — entram no jsonl da sessão).
  Paleta móvel pelo grip `⠿` (funciona
  até em pass-through — IPC `annotation:mouse from:"drag"` congela o poll do
  cursor); botão `📷 Print` (mesmo caminho do Ctrl+Alt+P);
  nenhuma ferramenta esconde o cursor do mouse (laser inclusive).
  `Ctrl+Z`/`Ctrl+Shift+Z` só com a overlay em modo desenho (nunca global).
  Marker (`Ctrl+M`) e rajada de anotação no ditado geram prints queimados em
  `frames/` (composite frame+marcações). Smoke determinístico: `--anotest`.
- **Observabilidade é Definition of Done** (mantenedor, 2026-09-23): o que
  rodou, como e o que aconteceu sempre fica registrado — funcionalidade nova
  nasce instrumentada (spans/métricas/log OTLP via `telemetry-core` +
  `logging`), sem "telemetria depois".
- **React/react-dom devem ficar na MESMA versão exata** (ex.: 19.2.7 +
  19.2.7) — minors diferentes (^19) resolveram 19.2.7/19.3.0 e quebraram a
  barra em runtime (React error #527, silencioso no build).
- **Telemetria OTel** (ver docs/RELATORIO-TELEMETRIA.md): métricas via core
  lazy `src/shared/telemetry-core.ts` — counters/histograms declarados no
  module-load resolvem o instrumento no primeiro emit (init do SDK é 3s
  pós-ready; emit antes disso é descartado). Endpoint `localhost:4318`
  (collector do unidocs), kill-switch `OTEL_ENABLED=0`. Start de gravação:
  barra nasce em `arming` ("preparando captura…") e `startedAt` vira o do
  `recorder.start()` — nunca usar o início do warm-up como relógio da sessão.
  Dashboard: Grafana local, uid `voicecast` (repo unidocs,
  `volumes/grafana/dashboards-json/`).

## Comandos

```bash
pnpm ci:local    # typecheck + test + build (WSL)
pnpm dev:win     # build + sync + executa no Windows
pnpm test
```

## CI

GitHub Actions (ubuntu): typecheck (com `ELECTRON_SKIP_BINARY_DOWNLOAD`), vitest,
build. O Windows é testado pelo dev loop local (não há runner de captura no CI).
