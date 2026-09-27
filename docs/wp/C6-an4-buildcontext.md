# C6 — AN.4: anotações no buildContext · pronto

## Objetivo
O "Copiar contexto p/ ZCode" (`buildContext`) passa a citar as marcações de
anotação da sessão (laser/pincel + prints queimados), para o agente consumidor
saber O QUE foi destacado na tela, além do áudio/transcrição.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (regras do repo)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (é aqui que a seção nova entra; note a seção "Trechos" como exemplo de formato)
- `/home/pedro/programing/projetos/voicecast/src/shared/annotations.ts` — motor
  puro: tipos de evento e fold do log (fonte da verdade do formato)
- `/home/pedro/programing/projetos/voicecast/src/main/annotations.ts` — como o
  `annotations.jsonl` é escrito (campo a campo) e onde ficam os prints queimados
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-ANOTACOES-TELA.md` —
  decisões do plano (WYSIWYG, prints D6/D7)

## Escopo
**Fazer:**
- Em `buildContext` (src/main/library.ts): nova seção `Anotações (N):` com, por
  marcação: tempo relativo (fmtTs), tipo (laser/stroke/erase…), e — quando
  existir print queimado correspondente em `frames/` — o path
  `wslPathQuoted(...)` do PNG.
- Lógica de leitura/agregação do jsonl em função PURA nova
  `src/shared/annotations-context.ts` (fold reaproveitando o motor puro),
  testável sem electron; `library.ts` só consome.
- Telemetria (DoD): counter `voicecast_context_annotations_total` (nº de
  marcações incluídas no contexto; 0 também emite? não — só quando houver).

**Não tocar:** motor de desenho/overlay, IPC, editor UI, asr/jev, runner.

## Aceite verificável
- `pnpm ci:local` verde em `/home/pedro/programing/projetos/voicecast`.
- Teste novo em `tests/annotations-context.test.ts` com fixture de jsonl
  (≥3 eventos: stroke, laser, clear) validando o resumo gerado.
- Teste em `tests/` provando que `buildContext` inclui a seção quando o
  jsonl existe (mock de fs como os testes de storage fazem) e não quebra
  quando não existe.

## Riscos e gotchas
- `annotations.jsonl` pode não existir (sessão sem anotação) — seção simples
  não aparece (comportamento atual da seção Trechos).
- Tempos do jsonl são relativos ao `startedAt` real (`recorder.start()`) —
  usar fmtTs como nas outras seções.
- Não ler prints de `frames/` além dos que existirem (readdir + match por
  timestamp arredondado, tolerante a não achar — linha sem path).

## Entrega
Commits convencionais (`feat(c6): …`) no repo, SEM push. Preencher a seção
Resultado abaixo.

## Resultado (preenche o piloto)
- (pendente)
