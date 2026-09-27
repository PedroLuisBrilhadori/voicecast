# C3 — Contexto no goal (bounded) · bloqueado por C2-unlock (U1)

## Objetivo
Todo goal falado/ digitado leva o contexto BOUNDED da última sessão voicecast
(quando recente e relevante), para o agente começar sabendo o que você estava
vendo/falando — sem você colar nada.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-COCKPIT.md` (C3 + decisões ratificadas)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (reuso; NÃO duplicar a lógica de montar markdown)
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` — onde o
  goal é montado/spawnado (o contexto entra aqui)
- `AGENTS.md` do repo (regras; seção Telemetria p/ padrão de métricas)

## Escopo
**Fazer:**
1. `src/shared/agent-context.ts` — função PURA `boundSessionContext(detail,
   opts)`: decide INCLUIR (última sessão < N min, default 30, e meta.jev
   relevância ≥2) e TRUNCA em ~2k tokens (na fronteira de palavra/linha);
   testável sem electron. Config por env `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`.
2. No runner (ou no chamador do GoalQueue): antes de spawnar, carregar a
   última sessão via `listSessions`/`getSessionDetail` e, se o boundContext
   incluir, concatenar ao goal num bloco delimitado claro:
   `--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---\n…\n--- FIM DO CONTEXTO ---`.
3. Telemetria (DoD): counter `voicecast_agent_context_total{com,sem}` +
   span attr `context.chars`.

**Não tocar:** protocolo/middleman (fora de escopo), editor UI, gate de
permissão (C5), barra (C4).

## Aceite verificável
- `pnpm ci:local` verde; testes novos de `boundSessionContext`: inclui/exclui
  por idade e relevância Jev; trunca em ~2k tokens na fronteira de palavra;
  sessão sem transcript não quebra.
- Teste de integração do runner com agente fake (fixture existente) provando
  que o bloco de contexto chega no stdin/argv conforme o desenho escolhido.

## Riscos e gotchas
- O contexto aumenta o custo do goal (plano real) — truncamento é
  OBRIGATÓRIO; nunca mandar transcript completo.
- Jev ausente (fail-soft) ⇒ sem relevância ⇒ só inclui se a sessão for
  recentíssima (< 5 min)? DECIDA conservador e documente no briefing.
- Path do sessions root é Windows — `getSessionDetail` do main já resolve.

## Entrega
Commits convencionais, sem push. Preencher Resultado abaixo.

## Resultado (preenche o piloto)

**Entregue em 2026-09-27** (piloto C3). Commits no repo, sem push:

- `6a6d751` `feat(c3): política pura do contexto bounded — boundSessionContext
  (~2k tokens, fronteira de palavra/linha)` — `src/shared/agent-context.ts`
  (novo, puro — sem electron/fs): `boundSessionContext(detail, opts)` decide
  INCLUIR e devolve o markdown BOUNDED (null = exclui); `sessionAgeMin`,
  `truncateToTokenBudget`, `wrapSessionContextBlock` e os delimitadores
  `SESSION_CONTEXT_BEGIN/END` exportados. Contrato puro `EnrichedGoal`/
  `GoalEnricher` também mora aqui (o runner importa só o shared — sem
  electron). + `tests/agent-context.test.ts` (18 testes).
- `cafb323` `feat(c3): contexto da última sessão no goal — enricher + counter
  + span attrs` — `src/main/agent/goal-context.ts` (novo):
  `goalContextEnricher()` carrega a última sessão (`listSessions[0]` →
  `getSessionDetail`), monta o markdown pelo `buildContext` **(reuso
  obrigatório — zero duplicação da montagem)** e aplica a política pura.
  `src/main/agent/runner.ts`: `RunGoalRequest.enrich?` + `GoalQueue(onState,
  enrich?)` — enrich roda ANTES do span `agent.goal`, que nasce com attrs
  `context.incluido=com|sem` e `context.chars`; enricher quebrado nunca
  quebra o goal. Counter `voicecast_agent_context_total{incluido=com|sem}`
  (DoD) no goal-context.ts. `tests/fixtures/fake-agent.sh` ganhou
  `FAKE_ECHO_ARGS=1` (ecoa o argv — retrocompatível) e
  `tests/agent-goal-context.test.ts` (13) + 3 testes no
  `tests/agent-runner.test.ts`.

**Política Jev-ausente (decisão exigida pelo briefing — conservadora):**

- Jev **presente**: inclui se idade < 30 min (env
  `VOICECAST_GOAL_CONTEXT_MAX_AGE_MIN`) **E** `meta.jev.relevancia >= 2`
  (mesma política do hook C7).
- Jev **ausente** (fail-soft: sem key/erro/off): só inclui se a sessão for
  **RECENTÍSSIMA (< 5 min) E tiver transcript**. Racional: sem sinal de
  relevância, a recência extrema + existência de fala são os únicos proxies
  de que o goal se refere àquela sessão; qualquer coisa mais velha sem Jev
  não entra (feature quase morta com Jev off é o preço conservador).
- Idade conta do **FIM** da sessão (`startedAt + durationS`, igual ao hook
  C7); skew de relógio (idade negativa no mount do Windows) é aceito (vira
  0); `startedAt` ausente/inválida → exclui (recência não comprovável).
- Sessão **sem transcript não quebra**: com Jev ok entra sem a seção de fala
  (markdown cita título/paths/julgamento); sem Jev não entra.
- Truncamento **sempre** aplicado: ~2000 tokens (≈ 8k chars a 4 chars/token —
  aproximação documentada), corte na fronteira de palavra/linha (a mais
  tardia dentro da janela; corte duro abaixo da metade) + marcador
  `… (contexto truncado)`. Transcript completo NUNCA vai (testado).

**Desenho da integração:** o enricher é **injetado** no runner
(`req.enrich` / construtor do `GoalQueue`) — o runner continua sem import de
electron (testes do runner intactos sem mock) e o chamador de produção (C4,
painel) liga com uma linha: `new GoalQueue(onState, goalContextEnricher())`.
O goal vai primeiro, o bloco delimitado vai concatenado depois
(`--- CONTEXTO DA ÚLTIMA SESSÃO (auto) ---\n…\n--- FIM DO CONTEXTO ---`).

**Evidências (aceite verificável):** `pnpm ci:local` verde
(typecheck + **167 passed / 4 skipped** — skips pré-existentes jev.smoke/
agent-live + build main/preload/renderer). Teste de integração prova o
efeito observável exigido: runGoal com enricher real (biblioteca real,
electron mockado → tmpdir) e o agente fake recebendo o bloco no argv
(`FAKE_ECHO_ARGS`) — e o goal frio (sessão velha) chega sem bloco.

**Pendências (torre de controle):**
- **C4** é o chamador de produção: passar `goalContextEnricher()` no
  construtor do `GoalQueue` (hoje nenhum código src instancia a fila).
- Gate humano no Windows (`pnpm dev:win`): validar o bloco num goal real e o
  counter/span chegando ao Grafana (painel uid `voicecast` pode ganhar a
  série `voicecast_agent_context_total` — fora do escopo do piloto).
- Com Jev off a política fica conservadora de propósito; se o mantenedor
  quiser janela fresh ajustável, basta um env novo (opts já suportam).

Achados: nenhum bug vizinho relevante.
