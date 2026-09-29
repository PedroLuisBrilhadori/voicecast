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

**ENTREGUE (2026-09-29)** — commits `1dda3f6..fa00a6a` (+docs). `pnpm ci:local`
verde: 219 testes (185→219, +34 do W2a), typecheck e build ok. Sem push.

### Schema descoberto no corpus (o disco é a spec)
- `datasets/transcriptions/YYYY-MM-DD/<HHMMSS-hash8>.json`: `id`, `ts` (ISO
  local sem Z), `audio` (rel `raw/<dia>/<id>.wav`), `duration_s`, `text` (CRU),
  `chars`, `confidence`, `device`, `paste_mode`, `model`, `language`,
  `source`, `n_words`, `words: [{w,start,end,p}]`, `quality`, `validation`,
  `ready_for_export`. Também há `raw/<dia>/<id>.wav` e `drafts/` (status).
- Correção no corpus = bloco `validation` no PRÓPRIO JSON (descoberto no
  código do painel antigo `voice-dictation/src/voice/corrections.py`, pois
  nenhum item do corpus tem validation ainda):
  `{corrected_text, ts, n_edits, edits:[{index,original_w,corrected_w}], labeled_by}` —
  `text` cru NUNCA muda; escrita atômica tmp+replace; idempotente.

### O que foi entregue
1. **Motor puro** `src/shared/corrections.ts`: sanitizeEdits (mesmas regras do
   corrections.py), applyEditsToWords (timings preservados), buildValidation,
   guard de id (sem traversal), datasetRootFrom (`VOICECAST_DATASET_DIR`
   override → `%LOCALAPPDATA%\voice-dictation\datasets`).
2. **Corpus** `src/main/dataset.ts`: lista (busca/filtro rotuladas, mais
   recente primeiro), detalhe (words/validation/áudio) e writeDatasetCorrection
   (validation, tmp+rename, fail-soft "ausente"/"erro").
3. **IPC** (contrato testado): `library:save-correction`,
   `library:open-corpus`, `dataset:list-items`, `dataset:get-item`,
   `dataset:save-correction` + payloads (`CorrectionEdit`, `CorrectionResult`
   com alvo/dataset, `ValidationBlock`, `DatasetItemSummary/Detail`).
4. **Correção na sessão** (`library.saveCorrection`): transcript.json com
   words editadas NO LUGAR (timings/conf preservados) e texto recomposto — ou
   texto puro trocado quando words vazio (gancho fake/ditados antigos);
   `meta.correction` (correctedAt/nEdits/dataset); dataset via
   `meta.datasetId` → alvo `ambos`/`voicecast`; counter
   `voicecast_corrections_total{alvo}`; broadcast sessions-changed.
5. **UI**: editor de sessões ditado ganha ✏️ corrigir (palavra clicável vira
   input inline; textarea no caso texto puro; badge ✓ corrigido; botão 📚
   dataset). Nova tela `?corpus` (janela editor reutilizada, `--open-corpus[=id]`)
   substitui o painel :8700: busca, filtro (todas/sem correção/rotuladas),
   detalhe com áudio + correção.

### Decisões
- **Link sessão↔corpus é explícito** (`meta.datasetId`): ditados voicecast não
  são gravados no corpus hoje (escrever ditado novo no layout do voice — wav +
  words — ficou fora do escopo do briefing e tocaria o pipeline de captura),
  então sessões sem link ficam `alvo=voicecast` (dataset "ausente"); o caminho
  `ambos` está implementado e testado para quando o link existir. Corrigir
  itens do CORPUS histórico (o caso do painel :8700) vai por
  `dataset:save-correction` (alvo=dataset).
- `labeled_by: "voicecast"` (o painel antigo usava "panel").

### Aceite
- ✓ correção preserva timings (testes corrections/correction-save)
- ✓ grava nos dois alvos quando dataset existe (fixture; NUNCA o corpus real —
  testes usam `VOICECAST_DATASET_DIR`/root explícito em tmp)
- ✓ fail-soft quando não existe (dataset "ausente", UI sinaliza)
- ✓ contrato IPC (canais estáveis + payloads serializáveis)
- ✓ `--ditado-test` intacto (ditado.ts/pythonEnv não tocados)

### Pendências / achados
- Gate do mantenedor (Windows): validar a tela 📚 dataset contra o corpus real
  (só leitura no WSL aqui) e um F9→corrigir ponta a ponta.
- Escrever ditados NOVOS no corpus (VISAO-V2 item 3 completo: wav em raw/ +
  words + link automático meta.datasetId) — issue #3 não fecha 100% sem isso;
  requer conversão webm→wav e toque no pipeline de captura (proibido aqui).
- Achado vizinho (não consertado, escopo estrito): `EditorApp.tsx` hardcode
  `C:\\Users\\pedro\\...` no botão "abrir pasta da sessão".
