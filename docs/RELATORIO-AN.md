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
# UI interativa: --anoui (overlay aberta 90s p/ dirigir mouse/teclado reais)
```

## Validação de UI REAL dirigida por agente (2026-09-22) ✅

A passada de UX que faltava foi executada sem humano: mouse sintético
(SetCursorPos + mouse_event via interop WSL→Windows) sobre a overlay real,
com screenshots por passo lidos visualmente + log do main como evidência.

| Passo | Resultado |
|---|---|
| Hotkey `Ctrl+Alt+B` (input sintético) | ✅ entrou em modo desenho (`modo desenho` no log) |
| **Clique na paleta "Pincel"** (pass-through → hover → click) | ✅ `annotationMouse from:draw` → modo desenho + cmd tool brush |
| Drag na tela (pincel) | ✅ pointerdown/move/up no canvas → **traço vermelho visível no screenshot** + stroke no jsonl |
| `Ctrl+Alt+L` + drag (laser) | ✅ rastro efêmero + caminho no log |
| `Ctrl+Alt+E` + drag (borracha) | ✅ funciona; hit-test por raio era limítrofe → **folga de 25% adicionada** |
| Status da paleta | ✅ "desenhando · Esc solta o mouse" ↔ "pass-through · Ctrl+Alt+Espaço desenha" |
| `Esc` | ✅ volta a pass-through (`modo pass-through` no log) |

**Bugs achados e corrigidos pela validação de UI:**

1. **Botões da paleta não ativavam o desenho** — mudavam só estado local do
   renderer; o main (dono de `setIgnoreMouseEvents`/`focusable`) não era
   avisado. Corrigido: paleta → `annotationMouse {from:"draw"}` → `cmdTool`.
2. **Hover da paleta em pass-through nunca chegava** — `forward:true`
   (forwarded mousemove) não entrega eventos de hover de forma confiável
   nesta máquina. Corrigido com o padrão determinístico: **main faz polling
   do cursor** (100ms) e habilita o mouse da janela quando o cursor está
   sobre o retângulo da paleta (reportado pelo renderer). Log
   `poll cursor → mouse da janela ON` confirma a transição.
3. **Paleta cortada pela barra de tarefas** — `bottom:18` → `bottom:48`.

Método (para reproduzir): ganchos `--anoui` (overlay 90s) + driver PowerShell
(`SetCursorPos`+`mouse_event`), screenshots por passo (CopyFromScreen) lidos
como imagem, `annotations.jsonl` e main.log como evidência estruturada.
Limitação honesta: "sensação de uso" (suavidade do traço, ergonomia dos
atalhos em uso real) só o mantenedor avalia — o resto está validado.

### Veredito Jev sobre a evidência (jev-1.13.0, 772ms)

- `verdicto_ux` (score 0–4): **3.05** (conf 0.96) — "funciona de ponta a
  ponta; ajustes menores ou cosméticos pendentes"
- `bloqueante` (noul): **0.17** — nada que exija correção antes do uso normal

## Pendências

- ~~Pass humana de UX~~ **validação funcional por agente concluída** (seção
  acima); sensação subjetiva de uso continua com o mantenedor.
- **AN.4**: linhas de anotação no `buildContext` + exposição no MCP (com E3).
- Laser queimado no print só quando recente (<1,5s) — calibrar se necessário.
- Paleta sempre-visível durante REC (WYSIWYG D2) — a paleta NÃO entra nos
  prints queimados (só frame+marcações), mas ENTRA no vídeo gravado (é janela
  na tela). Se incomodar no vídeo: esconder a paleta fora do hover (evolução).
