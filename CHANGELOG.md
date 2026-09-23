# Changelog

## [Unreleased] - 2026-09-22

Janela: 2026-09-19 → 2026-09-22. Do zero à v2: fundação Electron, captura completa (tela/janela/região) + pós-produção, absorção do voice-dictation (ditado F9, ASR próprio) e anotações em tela.

### Added

- **[m0]** Fundação Electron: atalho global Ctrl+F9, IPC tipado, storage layout, CI e dev loop WSL→Windows (3c4de4c)
- **[m1]** Captura completa de sessão: picker (tela/janela/região), overlay de seleção, barra REC e pipeline de sessão (e23ad1a)
- **[m2]** Pós-produção: transcrição ASR, editor sincronizado, clipes, prints, biblioteca e contexto para ZCode (bf6a70d)
- **[v2]** Ditado F9 dentro do voicecast, com coordenação de posse com o daemon (issues #1, #2) (41c6913)
- **[v2]** Histórico elaborado: ditado persiste como sessão de áudio + biblioteca com busca full-text (fa02415)
- **[v2]** Telemetria OTel (paridade voice v2) + feedback "transcrevendo…" na barra do ditado (01def3f)
- **[jev]** MVP Etapa 2: F9 roteia antes de colar + sessões com `meta.jev` (113bcff)
- **[an]** Anotações em tela (laser/pincel/borracha/undo) + prints queimados (AN.1/AN.2) (aac37fd)
- **[an]** Painel standalone de anotações: Ctrl+Alt+H global abre o painel fora de sessão; gravação/ditado adotam o painel aberto, preservando traços pré-REC (4afef1a)
- **[an]** Atalho extra Ctrl+Alt+X limpa as marcações, junto do Ctrl+Alt+C (c1445a0)
- **[asr]** Voicecast hospeda o próprio backend de transcrição — fim da dependência do voice-dictation (38fcc5c)
- **[tel]** Métricas OTel vivas de verdade (core lazy em `shared/telemetry-core.ts`) + instrumentação do start: `session_starts_total`, `session_start_seconds{stage}`, spans `session.start`/`recorder.load`/`recorder.open`/`sources.list` e dashboard Grafana `voicecast` (no unidocs)
- **[tel]** Barra REC abre na hora ("preparando captura…" com `arming`) e o relógio da sessão passa a ser o `recorder.start()` real — timer/duração/markers casam com o mp4 e a transcrição

### Changed

- **[an]** Paleta de anotações sob demanda: REC e ditado NÃO abrem mais a paleta (oculta por default; `Ctrl+Alt+H` mostra) — overlay segue viva em pass-through, com prints D6/D7, Ctrl+Alt+P e hotkeys intactos; painel standalone e `--anoui` mantêm paleta visível (revisão do mantenedor sobre o D2)
- **[docs]** Visão v2: voicecast absorve o voice-dictation (decisão do mantenedor) (fa66a4a)
- **[docs]** Plano de anotações em tela (laser/pincel/borracha/undo, print no modo transcrição) com decisões confirmadas pelo mantenedor: WYSIWYG, atalhos, paleta fixa, print em ambos os modos, laser persistindo o caminho no `annotations.jsonl` e print queimado automático ao anotar em modo somente-transcrição (306945b, d4409e3, 86d2b7e, cde5b77)
- **[ci]** Versão do pnpm passa a vir do `packageManager` do `package.json` (21c4d5f)

### Fixed

- **[v2]** Posse do F9 com heartbeat TTL — fim do F9 duplo na transição (4a7b059)
- **[v2]** Colagem via `paste_into_focused` do daemon (código provado, no lugar de SendKeys) (7efc223)
- **[an]** Validação de UI dirigida por agente: 3 bugs corrigidos + folga da borracha (df12a11)
- **[an]** Demandas do vídeo 0933: mouse visível no laser, paleta móvel, overlay não fica mais presa; ocultar paleta + print na paleta (a501b1a)
- **[an]** Paleta oculta de verdade — JSX ignorava o estado `palHidden` (botão/atalho mudavam o estado, mas a paleta continuava renderizada) (8b71f73)
- **[tel]** Bug das métricas inertes: counters/histograms criados no module-load capturavam meter `null` (init é 3s pós-ready) e nunca gravavam — só os spans eram emitidos

### Removed

- **[recorder]** Instrumentação de debug dos chunks (hex) do gravador (af34a54)
