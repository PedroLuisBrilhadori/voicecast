# W2a — Tela de correção de ditados + integração de dataset (issues #3+#5) · pronto

## Objetivo
Fechar a lacuna que ficou da aposentadoria do voice-dictation: corrigir/rotular
ditados DENTRO do voicecast (o painel :8700 morreu com o daemon) e conversar
com o dataset de treino histórico (mesmo corpus, layout words/corrections).

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/docs/VISAO-V2.md` — decisão da
  integração de dataset (item 3) e da tela de correção (substitui o painel)
- `/home/pedro/programing/projetos/voicecast/AGENTS.md` (regras do repo)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- Layout do dataset do voice (corpus histórico): datasets em
  `/mnt/c/Users/pedro/AppData/Local/voice-dictation/datasets/` — INSPICIONAR
  (só leitura!) o schema real de `transcriptions/` e `corrections/` (words,
  corrections, ids, timestamps) antes de desenhar; o voicecast DEVE ler e
  escrever o MESMO layout (issue #3). Não existe spec — o corpus é a spec.
- Editor atual: `src/renderer/EditorApp.tsx` (transcrição por palavra já
  clicável — a correção reedita palavras no lugar), `src/main/library.ts`,
  `src/shared/ipc.ts` (contrato é lei: muda aqui → preload + main + testes).

## Escopo
**Fazer:**
1. **Correção no editor** (ditados = sessões mode:"ditado"): modo "corrigir
   transcrição" que permite editar o texto/palavras da transcrição e grava a
   correção (transcript atualizado + campo de correção no meta/dataset).
   Mínimo viável: editar palavra(s) errada(s), preservar timings.
2. **IPC/contrato**: canais novos para salvar correção (+ testes de contrato).
3. **Integração dataset** (o que o corpus permitir): escrever a correção no
   layout do voice em `%LOCALAPPDATA%\voice-dictation\datasets\` (mesma
   estrutura que o export JSONL consome). Fail-soft: sem datasets dir, salva
   só no voicecast (meta/transcript) e sinaliza na UI.
4. **Telemetria (DoD)**: counter `voicecast_corrections_total{alvo}` (voicecast|dataset|ambos).

**Não tocar:** pipeline de captura/colagem (recém corrigido), cockpit (Onda 1),
runner/runtime-setup, painel do picker.

## Aceite verificável
- `pnpm ci:local` verde; testes: correção preserva timings; grava nos dois
  alvos quando dataset existe; fail-soft quando não existe; contrato IPC.
- Smoke `--ditado-test` continua determinístico (não quebrar o gancho).

## Riscos e gotchas
- O corpus do voice é DADO REAL de treino — escrever com backup/atômico
  (tmp+rename), nunca truncar; nunca em teste apontar pro corpus real.
- Layout descoberto no código do painel antigo se necessário: repo do
  voice-dictation pode estar em `~/programing/projetos/voice-dictation` (se
  existir) ou nos dados; o disco manda.
- Ditados antigos salvos SEM words (o gancho fake grava words:[]) — correção
  precisa lidar com texto puro também.

## Entrega
Commits convencionais (`feat(w2a): …`), sem push. Preencher Resultado abaixo.

## Resultado (preenche o piloto)
- (pendente)
