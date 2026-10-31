# ROADMAP

Trabalho planejado (o "espaço para crescer"). Concluídos e relatórios por
fase: [docs/](docs/) e [CHANGELOG.md](CHANGELOG.md).

## Em curso

### M4 — Polish
- [ ] Import de sessão externa (arrastar mp4 → biblioteca)
- [ ] Telemetria OTel: dashboards locais (paridade voice v2) — SDK ✅
- [ ] Wayland/note: rodada final de QA multi-monitor no modo região

## Próximos

### M3 — Modo ao vivo
- [ ] Spike → UI: sessão ao vivo consumível pelo agente enquanto grava
- [ ] Gate Jev: roteamento F9 → julgamento antes de colar (MVP ✅, faltam regras finas)
- [ ] TTS no painel (feedback falado)

### W2 — Correção de transcrição e dataset
- [x] Motor puro de correção + escrita atômica no corpus
- [x] Editor: palavra clicável → input inline, preservando timings
- [x] Painel do dataset (lista/busca/filtro, detalhe com áudio, rotulação)
- [ ] Fine-tuning consumindo o corpus rotulado (loop treino → avaliação)

### ASR plugável
- [ ] Abstrair o provedor de transcrição (hoje: faster-whisper local via `asr-backend/`)
- [ ] Suportar modelo local alternativo e API externa escolhida pelo usuário
- [ ] Settings: seleção de provedor/modelo no painel (par do toggle `asrHost`)

### Dívida / qualidade
- [ ] Empacotamento (electron-builder: AppImage/DEB no Linux, NSIS no Windows)
- [ ] CI remoto (GitHub Actions) espelhando o `ci:local`
- [ ] Documentar o contrato IPC (`src/shared/ipc.ts`) gerando referência
- [ ] Testes E2E do fluxo REC → transcreve → contexto (hoje os E2E são manuais via `--autotest`)
