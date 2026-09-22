# Relatório AN.1/AN.2 — Anotações em tela + auto-print/marker queimado

Data: 2026-09-22 · Plano: [PLANO-ANOTACOES-TELA.md](./PLANO-ANOTACOES-TELA.md)
Validez: engine + persistência + prints validados no Windows real (`--anotest`
e `--autotest`); UX interativa (desenhar com o mouse) pendente de pass humana.

## Resumo

| Item | Veredito |
|---|---|
| Motor puro (`src/shared/annotations.ts`): fold do log, undo/redo, borracha traço/área, decimação, hit-test por segmento | ✅ 16 testes |
| Engine main (`src/main/annotations.ts`): overlay fullscreen, hotkeys Ctrl+Alt+*, jsonl, seq/t, auto-print debounce 2s (D7), marker queimado (D6), print manual (AN.5), buffer do ditado | ✅ |
| Renderer (`AnnotationApp`): canvas, laser com fade, paleta (tools/cores/espessuras/undo-redo), modo desenho↔pass-through, composite frame+marcações | ✅ carrega e compõe |
| **Auto-print D7 validado no Windows**: rajada sintética (stroke+laser) → `frames/print-5_1s.png` com traço E laser queimados (verificação visual por visão) | ✅ |
| **Marker D6 validado no Windows**: `--autotest` → `frames/marker-1.png` + evento print kind=marker no jsonl da sessão real | ✅ |
| Persistência ditado: log (3 eventos) + print em buffer salvos no detach p/ o dir da sessão | ✅ |
| Suíte completa | ✅ 39 testes + build |

## Arquivos

Novos: `src/shared/annotations.ts` (motor puro), `src/main/annotations.ts`
(engine), `src/renderer/annotation.html` + `annotation-main.tsx` +
`AnnotationApp.tsx` (overlay), `tests/annotations.test.ts`.
Mudados: `ipc.ts` (canais anotação + `VcInternalBridge` canônico — os
`declare global` por renderer colidiam), `preload/index.ts`, `windows.ts`
(exporta dist/preload/wireLogging), `capture.ts` (attach no start, detach no
finalize/cancel/erro-remux, marker queimado), `ditado.ts` (attach/detach com
dir da sessão salva), `index.ts` (registerAnnotationIpc + `--anotest`),
`vite.config.ts` (input annotation), AGENTS.md.

## Decisões de implementação

- Sessão e ditado compartilham o padrão buffer→flush: o dir só existe no fim,
  então jsonl/prints acumulam em memória e persistem no detach (cancel
  descarta).
- `Ctrl+Z`/`Ctrl+Shift+Z` NÃO são globais (roubaria o undo do app embaixo):
  valem com a overlay em modo desenho (focusable) e pelos botões da paleta.
- Pass-through = `setIgnoreMouseEvents(true, {forward:true})` +
  `setFocusable(false)`; hover da paleta religa o mouse da janela
  temporariamente; `Esc` volta a pass-through.
- Composite é ping-pong main↔overlay (frame dataURL → canvas + strokes +
  lasers recentes → PNG b64); timeout 4s; lasers queimados se acabaram de
  acontecer (<1,5s).
- Hit-test da borracha contra SEGMENTOS (strokes são decimados — teste pegou
  o bug do meio do traço antes de ir pro Windows).

## Como validar (Windows)

```powershell
& $env:LOCALAPPDATA\voicecast\src\node_modules\electron\dist\electron.exe `
  $env:LOCALAPPDATA\voicecast\src --anotest     # jsonl + auto-print queimado
# REC com marker: --autotest (grava 8s, marca, queima frames/marker-1.png)
```

## Pendências

- **Pass humana de UX** (5 min): desenhar/laser/borracha/undo com o mouse de
  verdade, ESC/pass-through, paleta — sensação e atalhos em uso real.
- **AN.4**: linhas de anotação no `buildContext` + exposição no MCP (com E3).
- Laser queimado no print só quando recente (<1,5s) — calibrar se necessário.
- Paleta sempre-visível durante REC (WYSIWYG D2) — a paleta NÃO entra nos
  prints queimados (só frame+marcações), mas ENTRA no vídeo gravado (é janela
  na tela). Se incomodar no vídeo: esconder a paleta fora do hover (evolução).
