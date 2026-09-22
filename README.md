# voicecast

Sessões de contexto: você fala e mostra a tela — o voicecast grava **voz + vídeo**
localmente, transcreve com o ASR local (voice-dictation, `127.0.0.1:8701`) e
transforma a sessão em **referências consumíveis por agentes de código**
(trechos, prints, transcrição com timestamps, contexto pronto para colar).

Tudo 100% local (nada sai da máquina).

## Estado

| Marco | Escopo | Estado |
|---|---|---|
| F0 | De-risk: decisão Electron vs Tauri, pipeline MP4, handoff ZCode | ✅ ([relatório](docs/RELATORIO-F0.md)) |
| M0 | Repo + fundação Electron (Ctrl+F9, IPC, storage layout, CI) | ✅ |
| M1 | Captura: tela cheia / janela / região + barra REC + remux MP4 | ✅ |
| M2 | Editor (transcrição sincronizada), clipes, prints, biblioteca, copiar contexto | ✅ |
| M3 | Modo ao vivo (spike → UI), gate Jev, TTS | futuro |
| M4 | Polish: Wayland/note, telemetria OTel, import externo | em curso — telemetria ✅ ([relatório](docs/RELATORIO-TELEMETRIA.md)) |

## Arquitetura

- **Runtime:** Electron (decidido na F0 — WebView2 negou `getDisplayMedia`)
- **Main:** janelas (picker/overlay/barra), atalhos globais, captura, ffmpeg, storage
- **Renderer:** React 19 + Vite + TS; IPC tipado em `src/shared/ipc.ts`
- **ASR/TTS:** cliente HTTP do `:8701` (voice-dictation) — único acoplamento externo
- **Dados:** `%LOCALAPPDATA%\voicecast\sessions\YYYY-MM-DD\<hhmm-hash>\`
  (`original.fmp4`, `session.mp4`, `meta.json`, `transcript.json`, `clips/`, `frames/`, `thumbs/`)

## Desenvolvimento (padrão dois ambientes: WSL build + Windows run)

```bash
# no WSL (repo): typecheck + testes + build
pnpm install
pnpm ci:local

# build + sync p/ a cópia do Windows + executa lá (captura real da tela)
pnpm dev:win
```

O Windows roda uma cópia em `%LOCALAPPDATA%\voicecast\src` (node_modules do
Windows), sincronizada por `scripts/sync-to-host.ps1` — mesmo padrão do
voice-dictation. A captura de tela só funciona no Windows (app desktop real).

Atalhos: **Ctrl+F9** painel · **Ctrl+Shift+F9** gravar tela cheia (M1).

## Testes

```bash
pnpm test      # vitest: contrato IPC, paths (WSL), layout de sessão
```
