# voicecast

Sessões de contexto: você fala e mostra a tela — o voicecast grava **voz + vídeo**
localmente, transcreve com o ASR local (faster-whisper servido em `127.0.0.1:8701`)
e transforma a sessão em **referências consumíveis por agentes de código**
(trechos, prints, transcrição com timestamps, contexto pronto para colar).

Tudo 100% local (nada sai da máquina).

**Para quem é:** desenvolvedores que trabalham com agentes de codificação
(Claude Code, ZCode, Copilot...) e precisam explicar contexto ao vivo —
demonstrar um bug na tela, ditar um requisito, mostrar um comportamento —
e querem que isso vire material aproveitável (transcrição, prints, clipes)
sem copiar/colar na mão.

## Como funciona

1. **Grava** — atalho global abre o picker: tela cheia, janela ou região.
   Barra REC flutuante, pipeline ffmpeg (fMP4 → MP4).
2. **Transcreve** — ao parar a gravação, o backend ASR embutido
   (faster-whisper + FastAPI, GPU quando disponível) gera a transcrição
   com timestamps por palavra.
3. **Edita** — editor sincronizado com o player: trechos nomeados, cortes
   exportados, prints, correção de transcrição clicável.
4. **Consome** — "copiar contexto" monta um bloco com transcrição, trechos,
   paths de arquivos e prints, pronto para colar na conversa com o agente.

Inclui ainda: **ditado por voz** (F9, cola direto no app em foco),
**anotações em tela** (laser/pincel/borracha sobrepostas à gravação) e
**biblioteca** de sessões com busca full-text.

## Stack

- **Electron** (main: janelas, captura, ffmpeg, IPC tipado; renderer: React 19 + Vite + TS)
- **ffmpeg** para gravação/remux/cortes
- **Python** (faster-whisper + FastAPI) no backend ASR vendorizado em `asr-backend/`

> **Sobre o ASR:** o `asr-backend/` é um **motor de transcrição que roda
> localmente, no computador do usuário** — o voicecast não é (nem pretende
> ser) um serviço de IA: não serve modelos para terceiros, não hospeda
> inferência remota e não envia nada para fora da máquina. O motor é um
> detalhe de implementação: o roadmap prevê o provedor de transcrição
> **plugável** (outro modelo local, ou uma API à escolha do usuário).
- **OpenTelemetry** opcional (métricas/traces OTLP HTTP)
- Testes: **Vitest** (contrato IPC, paths, layout de sessão, motores puros)

## Rodando

Requisitos: Node 22+, pnpm 10, ffmpeg no PATH, Python 3.11+ com CUDA
(opcional — sem GPU o ASR roda em CPU, mais lento).

```bash
pnpm install          # (--ignore-workspace se estiver num workspace pnpm)
pnpm build            # main + preload + renderer

# Linux (Arch/KDE Wayland — máquina de desenvolvimento atual)
scripts/setup-asr-backend.sh   # instala o backend ASR (uma vez)
scripts/run-linux.sh           # sobe o app (VOICECAST_OZONE=wayland p/ modo nativo)

# Windows (legado, era WSL — build no WSL, execução no host)
pnpm dev:win
```

Atalhos: **Ctrl+F9** painel · **Ctrl+Shift+F9** gravar tela cheia ·
**F9** ditado · **Ctrl+Alt+H** painel de anotações.
No KDE Wayland os atalhos globais exigem binding manual no KCM
(`kcm_keys`) — o app registra, o KWin não amarra sozinho.

### Dados

Sessões ficam no userData do Electron, uma pasta por sessão
(`sessions/YYYY-MM-DD/<hhmm-hash>/` com `session.mp4`, `meta.json`,
`transcript.json`, `clips/`, `frames/`, `thumbs/`):

- Linux: `~/.config/voicecast/sessions/`
- Windows: `%APPDATA%\voicecast\sessions\`

Configurações em `settings.json` ao lado (ex.: `asrHost` liga/desliga o
backend ASR em runtime, liberando a GPU).

## Desenvolvimento

```bash
pnpm ci:local   # typecheck + testes + build — o gate de todo commit
pnpm test       # vitest
```

A anatomia do projeto (janelas, IPC, storage, convenções de commit) está em
[AGENTS.md](AGENTS.md); decisões e relatórios por fase em [docs/](docs/).

Planos de trabalho futuro: [ROADMAP.md](ROADMAP.md).

## Licença

[MIT](LICENSE)
