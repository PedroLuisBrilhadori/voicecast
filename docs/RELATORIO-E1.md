# Relatório Etapa 1 — Fundação Jev: um cliente só

Data: 2026-09-21 · Escopo: workspace `projetos` (scripts da raiz) · Plano:
[PLANO-JEV-CU.md](./PLANO-JEV-CU.md)

## Resumo

| Item | Veredito |
|---|---|
| Cliente canônico `scripts/lib/jev-judge.mjs` (SDK oficial por dentro) | ✅ criado |
| Drift corrigido (`boolean` → só `noul\|choice\|score`; `choice` novo) | ✅ com validação na fronteira |
| Perguntas/limiares num arquivo só (`lib/jev-questions.mjs`) | ✅ PAUSA + QA_RUBRICA + faixas |
| Migração dos 3 callers (guardrail, qa, calibrate) | ✅ comportamento preservado |
| Golden tests com resposta REAL da API gravada | ✅ 5/5 |
| Suíte do workspace | ✅ 121/121 |
| Verificação ao vivo (cliente + qa + calibrate) | ✅ 723ms · vereditos idênticos ao probe |
| Telemetria JSONL (`~/.local/state/jev-judge.log`) | ✅ eventos com origem/tokens |

## O que mudou

- **`scripts/lib/jev-judge.mjs`** (novo): cliente canônico ESM plain sobre
  `@typesafe-ai/sdk@0.6.0` (instalado na raiz). Casca house
  `{state, questions} → {respostas, model, latenciaMs, usage}`; `fetch`
  injetável p/ testes; `timeoutMs` por tentativa + `maxRetries` (default 1;
  hooks passam 0); validação de questions que rejeita drift (ex.: `boolean`)
  com mensagem que aponta o conserto; reexporta `APITimeoutError`.
- **`scripts/lib/jev-questions.mjs`** (novo): PAUSA (pergunta do guardrail),
  JEV_THRESHOLD (0.7), QA_RUBRICA e QA_FAIXAS — arquivo único revisável
  (orientação da doc oficial da TypeSafe).
- **`scripts/jev-guardrail.mjs`**: fetch inline → `jevJudge` (1 tentativa,
  orçamento JEV_TIMEOUT_MS preservado); pergunta importada de
  jev-questions.mjs; fail-open e mensagens stderr idênticos; kill-switch e
  zona cinza intocados.
- **`scripts/jev-qa.ts`**: `jevScore` via cliente canônico; veredito usa
  QA_FAIXAS; saída CLI idêntica.
- **`scripts/jev-calibrate.ts`**: usa a MESMA PAUSA do hook (o texto local
  tinha drift sutil — "destruição irreversível" vs "…ou sobrescrita…" —
  calibração agora reavalia exatamente a pergunta production).
- **`scripts/lib/jev-judge.ts`**: agora fachada tipada do .mjs (import path
  estável p/ tsx); tipos corrigidos (noul|choice|score + legend/choice).
- **`scripts/jev-judge.test.mjs`** (novo): golden tests com a resposta REAL
  do probe 2026-09-21 (contrato gravado vira regressão) — payload (URL/auth/
  model/criteria), round-trip da PAUSA, rejeição de `boolean`, validações e
  telemetria JSONL (ok:true/ok:false).

## Verificações ao vivo (API real, 2026-09-21)

- Cenário probe voicecast via cliente canônico: `jev-1.13.0` · **723ms** ·
  812in/120out · rota `comando_agente` 0.98 · pedido 0.98 · risco 0.97 ·
  relevância 2.93/3 — idêntico ao probe com fetch cru.
- `jev-qa`: APROVA 3.86/4 (conf 0.88) · exit 0 · formato de saída idêntico.
- `jev-calibrate --limit 2`: 0 erros, 0 divergências, 1 limítrofe.

## Pendências / observações

1. **Guardrails OFF por marcador desde 19/09** (jev, mimosa, questions —
   decisão do mantenedor). O e2e do hook (stdin → API → exit 2) não rodou por
   isso; todo o resto do caminho está coberto (unit + golden + live). Religar
   os marcadores reativa o teste de ponta a ponta — decisão do mantenedor.
2. Ingestão do `jev-judge.log` pelo otel-sidecar não verificada (eventos
   caem no arquivo no padrão dos demais; conferir se o sidecar cobre o
   arquivo novo → dashboard).
3. Modificações pré-existentes no working tree (vault-docs*.ts, unrelated a
   esta etapa) não foram tocadas.
4. Commits: pendentes (mantenedor decide — arquivos: package.json,
   pnpm-lock.yaml, scripts/jev-*.{mjs,ts}, scripts/lib/jev-*.{mjs,ts}).

## Próximo passo

Etapa 2 (julgamento dentro do voicecast): `src/main/jev.ts` +
`jev-questions.ts`, pós-sessão em `meta.json`, roteamento do F9 com
confidence gate ≥0.9.
