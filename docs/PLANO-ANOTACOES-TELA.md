# Plano — Anotações em tela durante REC + print no modo transcrição

Data: 2026-09-22 · Status: **proposto** (decisões em aberto no fim)
Trilha nova (AN) — paralela às Etapas Jev (E1–E5 do
[PLANO-JEV-CU.md](./PLANO-JEV-CU.md)); consome a infra delas no buildContext/MCP.

## Objetivo

Enquanto grava (ou dita), o usuário **aponta e marca a tela** — laser, pincel,
borracha, desfazer/refazer — e as marcações viram **contexto consumível pelo
agente**: vetorial com timestamps + prints queimados nos momentos marcados. No
modo transcrição (ditado/sessão transcrevendo), um print da tela anexa à sessão.

## Decisões de design (recomendações)

**D1 — Vetorial desde o dia 1.** Marcação = evento em `annotations.jsonl` da
sessão, em **px físicos** (lição DPI 1.53 do F0) e **t relativo ao startedAt**
(consistente com `meta.markers` em segundos). Tudo deriva do log: replay do
estado, undo/redo, render de PNG queimado, resumo para o agente.

```jsonl
{"t":132.4,"seq":18,"type":"stroke","tool":"brush","color":"#ff4444","width":4,"points":[[x,y,ms],…]}
{"t":140.1,"seq":19,"type":"erase","mode":"stroke","target":17}
{"t":141.0,"seq":20,"type":"erase","mode":"area","points":[[x,y],…],"radius":12}
{"t":150.0,"seq":21,"type":"clear"}
{"t":152.2,"seq":22,"type":"undo"}
{"t":155.0,"seq":23,"type":"redo"}
{"t":160.0,"type":"marker","id":3,"frame":"frames/marker-3.png","strokes":[15,17,18]}
```

**D2 — WYSIWYG: as marcações SAEM no vídeo gravado.** A camada de anotação é
uma janela overlay na tela (evolução do overlay de região já provado no F0);
como o capture grava a tela, o que o usuário vê é o que o vídeo tem. Cursor do
sistema NÃO sai no capture do desktopCapturer — o **laser é O jeito de apontar
no vídeo**. Alternativa (vídeo limpo + marcação só para o usuário) exige
queimar em pós via log vetorial — fica como evolução, não v1 (ver aberto nº 1).

**D3 — Laser é efêmero.** Rastro com fade (~600ms), não entra no `annotations.jsonl`
(por padrão; flag `VOICECAST_LASER_LOG` futura p/ dataset de atenção). O que
fica do laser é o print queimado do marker, se estiver ativo no momento.

**D4 — Overlay desenha OU deixa passar; nunca os dois.** Dois modos:
**desenho** (overlay captura o mouse e desenha) e **pass-through**
(`setIgnoreMouseEvents(true, {forward:true})` — usuário interage com o app
demonstrado). Alternância por atalho/paleta; Esc volta a pass-through. Sem
isso o usuário não consegue operar o app que está demonstrando.

**D5 — Histórico = replay do log.** Desfazer `Ctrl+Z`, refazer `Ctrl+Shift+Z`
(ou `Ctrl+Y`); ilimitado na sessão; os eventos `undo`/`redo` também são
gravados (o log é a fonte da verdade, o stack é estado derivado).

**D6 — Marker vira âncora de contexto.** `Ctrl+M` (já existe) passa a:
capturar o frame naquele instante + **queimar os strokes ativos** (e laser, se
on) → `frames/marker-N.png` + evento `marker` no jsonl. Hoje marker é só
timestamp; com isso ele vira o "olhe aqui" do agente (GLM lê PNG nativamente).

## Ferramentas v1

| Ferramenta | Comportamento |
|---|---|
| **Laser** (L) | Ponteiro com rastro que some (~600ms); para apontar no vídeo; efêmero |
| **Pincel** (B) | Freehand; 4 cores (vermelho, amarelo, verde, ciano) × 3 espessuras; stroke vetorial |
| **Borracha — modo traço** (E) | Remove o stroke inteiro tocado (hit-test no log) |
| **Borracha — modo normal** (E·duplo) | Apaga por proximidade: divide/remove segmentos dentro do raio |
| **Limpar** (C) | Apaga tudo (evento `clear` — desfazível) |
| **Desfazer/Refazer** | `Ctrl+Z` / `Ctrl+Shift+Z` + botões na paleta |

Paleta compacta sempre-visível durante REC (irmã da barra REC, canto):
tools, cores, espessura, undo/redo, indicador do modo (desenho/pass-through).
Atalhos globais durante REC: `Ctrl+Alt+L/B/E/C` ferramentas, `Ctrl+Alt+Espaço`
alterna desenho↔pass-through (proposta — ver aberto nº 2).

## Print no modo transcrição (AN.5)

Durante **ditado (F9) em recording/transcribing** ou **sessão em REC**:
`Ctrl+Alt+P` → `desktopCapturer.getSources` full-res no main →
`frames/print-<t>s.png` na sessão corrente (a do ditado ou a da gravação) →
listado no buildContext. Sem sessão ativa: ignora com log. (Mesmo mecanismo do
marker, sem strokes.)

## Contexto para agentes (AN.4)

`buildContext` passa a incluir:

```
Marcações: 4 (pincel 02:13, borracha 02:20, pincel 04:51, clear 05:02) — vetoriais com timestamps em annotations.jsonl
Prints c/ marcação: frames/marker-2.png · frames/marker-3.png
```

O MCP da Etapa 3 (E3) expõe `annotations {dir,name}` junto de
`session_get`. Evoluções: clipe automático ±3s em cada marker; resumo
semântico das marcações via Jev (score de relevância por trecho).

## Sub-marcos

- **AN.1 — Overlay de anotação + paleta** (janela, modos desenho/pass-through,
  atalhos; laser e pincel funcionando em tela, ainda sem REC). Aceite:
  desenhar/apontar sobre qualquer app, alternar pass-through, Esc limpa modo.
- **AN.2 — Eventos + histórico**: strokes/eraser/clear/undo/redo em
  `annotations.jsonl` (px físicos, t relativo); borracha nos 2 modos.
  Aceite: replay determinístico do estado a partir do log (teste unitário).
- **AN.3 — Marker queimado**: Ctrl+M → frame + strokes → `frames/marker-N.png`
  (composite canvas no renderer da overlay). Aceite: print com as marcações
  visíveis listado no buildContext.
- **AN.4 — Contexto**: linhas no buildContext + campo no MCP (com E3).
- **AN.5 — Print na transcrição**: `Ctrl+Alt+P` durante ditado/REC →
  `frames/print-*.png`. Aceite: print aparece no contexto da sessão do ditado.

Sequência: AN.1 → AN.2 → AN.3 → (AN.4 com E3) → AN.5. AN.1/AN.2 são a base
de tudo; AN.5 é independente e barato (pode andar junto com AN.3).

## Riscos e contramedidas

- **DPI 1.53**: tudo em px físicos desde o dia 1 (overlay de região já provou
  a matemática CSS×física).
- **Performance durante REC**: overlay é canvas 2D leve (RAM ~50–80MB a mais,
  contra 566MB pico atual); medir no AN.1.
- **Overlay no vídeo quando NÃO deveria** (usuário esquece o modo desenho):
  indicador claro na paleta + Esc volta a pass-through.
- **Multi-display**: v1 no display gravado (o mesmo da sessão); evolution.
- **Roubo de foco**: overlay nunca toma foco salvo em modo desenho ativo;
  atalhos globais, não locais.

## Decisões em aberto (mantenedor)

1. **Marcações no vídeo** — WYSIWYG (recomendo; simples e o vídeo conta a
   história) vs. vídeo limpo + queima em pós via log (mais trabalho, mais
   "produção").
2. **Atalhos** — `Ctrl+Alt+L/B/E/C/P` + `Ctrl+Z/Y` batem com algo no seu uso?
   Alternativa: segurar tecla modificadora para desenhar (momentâneo).
3. **Paleta** — 4 cores × 3 espessuras fixas bastam? (customização fica p/ v2)
4. **Print na transcrição** — confirme o escopo: no F9 (ditado) E na sessão
   REC, certo? Ou só no ditado?
