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
- (pendente)
