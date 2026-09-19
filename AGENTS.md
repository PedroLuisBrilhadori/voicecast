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
| `src/shared/ipc.ts` | Contrato IPC tipado — canais + payloads. Mudou aqui → muda preload + renderer + testes |
| `src/shared/paths.ts` | Helpers puros (WSL path, nomes de sessão) — testáveis |
| `src/main/` | Processo principal: janelas, atalhos globais, captura, ffmpeg, storage |
| `src/main/storage.ts` | Único lugar que monta path de dados (`%LOCALAPPDATA%\voicecast`) |
| `src/preload/` | Ponte contextBridge — só expõe o contrato |
| `src/renderer/` | React 19 (picker, overlay de região, barra REC, editor, biblioteca) |
| `tests/` | Vitest (contrato, paths, storage) |
| `scripts/` | sync-to-host.ps1 / run-win.ps1 (dev loop Windows) |
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
- ASR: sempre via HTTP `:8701` (failover de URLs, padrão asr_router) — nada de
  embutir whisper aqui.

## Comandos

```bash
pnpm ci:local    # typecheck + test + build (WSL)
pnpm dev:win     # build + sync + executa no Windows
pnpm test
```

## CI

GitHub Actions (ubuntu): typecheck (com `ELECTRON_SKIP_BINARY_DOWNLOAD`), vitest,
build. O Windows é testado pelo dev loop local (não há runner de captura no CI).
