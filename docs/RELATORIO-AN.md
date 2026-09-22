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

## Demandas do vídeo 2026-09-22 0933 + follow-up do mantenedor (implementado)

A sessão `2026-09-22/0933-7329b0fb` (transcrita após o ASR hosted — ver
RELATORIO-ASR-HOST.md) registrou 3 demandas; o mantenedor pediu 2 extras no
mesmo dia. Tudo implementado e validado (fix 3 com E2E por log; 1, 2 e extras
com build+suíte verdes e pass de uso a cargo do mantenedor):

1. **"Quando eu clico no laser, meu mouse some"** — o renderer escondia o
   cursor (`cursor:none`) no modo desenho com laser. Agora nenhuma ferramenta
   esconde o mouse (crosshair em todas).
2. **"Movimentar a janela de pintura como o indicativo de gravação"** — a
   paleta ganhou grip `⠿` + drag por pointer events (clamp na tela). Como a
   overlay é fullscreen, `-webkit-app-region` não serve (moveria a janela);
   em pass-through o drag travou o mouse da janela ON via
   `annotation:mouse from:"drag"` (poll do cursor congelado durante o arrasto)
   e os bounds são re-reportados a cada movimento.
3. **"Ao parar o vídeo ou a transcrição, a janela de pintura não sai"** —
   vazamento REAL confirmado no log de 09:33: o `catch` do `toggleDitado`
   (falha de ASR) não fazia detach — a overlay ficava presa. Fix: detach no
   catch. No vídeo, blindagem extra: stop sem blob do recorder em 20s →
   descarte + cleanup (senão `finalizeSession` nunca roda e o detach tampouco).
   E2E: `--ditado-test` com `VOICECAST_ASR_URLS` morto → erro e `detach` 3ms
   depois (13:26:50.381 → .384).
4. **Ocultar a paleta (pedido do mantenedor)** — botão `⏷ ocultar` na paleta e
   hotkey `Ctrl+Alt+H` (toggle pelo engine, estado único no main). Oculta,
   reporta bounds `null` (hover do poll não liga o mouse) e o desenho segue
   funcionando pelas hotkeys. Volta no próximo attach.
5. **Print embutido na paleta (pedido do mantenedor)** — botão `📷 Print`
   chama o mesmo caminho do `Ctrl+Alt+P` (frame sem marcações → `frames/`,
   contagem `manual`).

Validação de uso (drag, ocultar/mostrar, print, laser com mouse visível):
pass de ~2 min do mantenedor — input sintético foi descartado nesse round
(máquina em uso).

## Painel standalone (2026-09-22, pedido do mantenedor)

"Seria legal poder abrir o painel antes de iniciar uma gravação, e o atalho
de ocultar/exibir funcionar fora de transcrição/gravação":

- **Ctrl+Alt+H virou global do app** (registro no `whenReady`, fora da lista
  de hotkeys por-sessão): sem overlay → abre o **painel standalone**; com
  overlay → oculta/mostra a paleta (como já fazia em sessão).
- Painel standalone = anotação como rascunho, sem sessão. Botão `✕ fechar`
  na paleta fecha e descarta. `Ctrl+Alt+H` de novo oculta/mostra; o painel
  também serve para preparar o desenho ANTES de gravar.
- **Adoção**: `beginSession` (capture.ts e ditado.ts) — se o painel
  standalone está aberto quando REC/ditado começa, a sessão o adota: overlay
  não é recriada, eventos/seq preservados, traços pré-REC entram no
  `annotations.jsonl` (t continua contando da abertura do painel, sem
  negativos). Hotkeys não são re-registradas (guarda `hotkeysOn`).
- Detalhe de TS: `open()` não pode referenciar `this.overlay` depois do
  early-return (narrowing para `null` ignora a mutação de `createOverlay()`)
  — send do cmd de modo isolado em `sendMode()`.

## AN.6 — Scroll-through (roda do mouse no modo desenho) + laser Ctrl+Alt+G (2026-09-22)

Pedidos do mantenedor: no modo desenho (laser/pincel/borracha) a roda do mouse
morria no overlay (a página embaixo não rolava) e, ao rolar, a tela "parecia
congelar". E o laser `Ctrl+Alt+L` fica na metade direita do teclado.

**Causa raiz (duas, descobertas no wheeltest)**:

1. Em modo desenho o overlay é uma janela OS normal cobrindo a tela — o
   hit-test do Windows entrega a roda a ele e ninguém tratava
   (`forward:true` do Electron só cobre mousemove). Fix: renderer escuta
   `wheel` → IPC `annotation:wheel` → main injeta `WM_MOUSEWHEEL` via
   **koffi/user32** na janela DE BAIXO do ponto.
2. O repost inicial caía **no próprio overlay**: `WindowFromPoint` devolvia o
   HWND **filho** do overlay (Chrome_RenderWidgetHostHWND), e o toggle de
   `WS_EX_TRANSPARENT` não o exclui do hit-test — janela Electron é
   `WS_EX_NOREDIRECTIONBITMAP`, **não layered** (skip por estilo exige
   `WS_EX_LAYERED`). Cada roda voltava ao overlay → rajada de eventos =
   "congelamento". Fix definitivo: `SetWindowPos` empurra o overlay para fora
   da tela por um instante (sem tocar em foco/z/estilo), `WindowFromPoint`
   acha a janela real, e volta — tudo síncrono; **uma vez por RAJADA de roda** (volta 150ms após a última — mover por evento forçava recomposição do DWM dezenas de vezes/s e engasgava o mouse; confirmado pelo mantenedor). Segurança
   anti-loop: compara `GetAncestor(GA_ROOT)` do alvo com a raiz do overlay.
   `Ctrl+roda`/`Shift+roda` seguem (MK_* no wParam); janela elevada (UIPI)
   ignora o post silenciosamente (fail-soft).

**Atalho**: laser `Ctrl+Alt+L` → **`Ctrl+Alt+G`** (decisão do mantenedor:
cluster todo na metade esquerda — mão direita fora do teclado). Demais
atalhos inalterados (B/E/C/X/Espaço/P/H já são da esquerda).

**Arquivos**: `src/shared/wheel.ts` (motor puro: delta/wParam/lParam, 9
testes), `src/main/native-wheel.ts` (koffi lazy, fail-soft fora do Windows),
canal `annotation:wheel` (ipc + preload), listener no `AnnotationApp`
(fora do React onWheel — passive), smoke `--wheeltest` (invisível).

**Validação**: ci local (typecheck + 55 testes + build); cadeia IPC→user32
exercitada no host (post=true, alvo confirmado por log). **Pass humano
pendente**: rolar uma página real com o laser ativo. Rodadas de teste que
congelaram/deram `TypeError 7 vs 4 args` no host foram builds intermediários
misturados pelo robocopy durante boot — resolvido com restart; se voltar,
sempre reiniciar o app APÓS o `dev:win` (scripts/ensure-app-win.ps1).
