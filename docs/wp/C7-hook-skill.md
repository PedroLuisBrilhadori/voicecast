# C7 — Hook UserPromptSubmit + skill voicecast no ZCode · pronto (gate humano)

## Objetivo
Quando o mantenedor trabalha DENTRO do ZCode, o contexto da última sessão
voicecast chega sozinho: hook `UserPromptSubmit` injeta digest bounded
(relevância Jev ≥2) e uma skill ensina o agente a consumir os artefatos.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/docs/PLANO-COCKPIT.md` (item C7)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- `/home/pedro/programing/projetos/zcode.json` (workspace) — como hooks da casa
  são registrados (sigam o padrão dos hooks existentes; TODO novo hook entra
  neste arquivo com `enabled: false` até o gate humano)
- `/home/pedro/programing/projetos/voicecast/src/main/library.ts` — `buildContext`
  (o digest é uma versão BOUNDED dele: ~500 tokens)
- Sessões voicecast no disco (via WSL): layout em `AGENTS.md` do voicecast;
  raiz `%LOCALAPPDATA%\voicecast\sessions` = `/mnt/c/Users/pedro/AppData/Local/voicecast/sessions`

## Escopo
**Fazer:**
1. Script `scripts/lib/voicecast-context-digest.mjs` NO WORKSPACE RAIZ
   (padrão dos hooks da casa: node puro, sem deps): lê a última sessão
   (< N min, default 30, env `VOICECAST_DIGEST_MAX_AGE_MIN`), monta digest
   bounded (título, duração, transcrição se Jev relevância ≥2, paths WSL dos
   artefatos), imprime no stdout como bloco markdown. Sem sessão recente:
   sai em silêncio (exit 0, sem output).
2. Registro do hook `UserPromptSubmit` em `/home/pedro/programing/projetos/zcode.json`
   com `"enabled": false` (o mantenedor liga no gate).
3. Skill `.zcode/skills/voicecast/SKILL.md` no workspace: quando/how pedir
   contexto voicecast, contrato dos artefatos (prints PNG ≤30MB, clipes MP4,
   transcript com timestamps — regra F0).
4. Telemetria (DoD): JSONL de uso no padrão dos guardrails
   (`~/.local/state/voicecast-digest.log` — uma linha por injeção).

**Não tocar:** repo voicecast src/ (só docs se precisar), nenhum outro hook,
qualquer `enabled: true`.

## Aceite verificável
- `node scripts/lib/voicecast-context-digest.mjs` com sessão fake em
  diretório temporário (env `VOICECAST_SESSIONS_ROOT` p/ testes) imprime o
  digest esperado; sem sessão, silêncio; idade > N, silêncio.
- Testes `node --test scripts/*.test.mjs` da raiz continuam verdes + teste
  novo do digest (fixtures em scripts/lib/__tests__/).
- Skill existe e referencia paths corretos.

## Riscos e gotchas
- zcode.json é config do harness do mantenedor — MUDANÇA MÍNIMA (só o bloco
  novo, enabled false). Qualquer dúvida de formato: copiar o padrão de um
  hook existente no mesmo arquivo.
- Nunca logar conteúdo do transcript no JSONL de telemetria (só metadados).

## Entrega
Commits convencionais NOS DOIS repos (raiz: hook+skill; voicecast: nada ou
docs). Sem push. Preencher Resultado.

## Resultado (preenche o piloto)

**Entregue em 2026-09-27** (piloto C7). Commits no workspace raiz, sem push:

- `feat(c7): hook UserPromptSubmit do digest voicecast (desligado até o gate)` —
  `scripts/lib/voicecast-context-digest.mjs` (node puro, funções puras
  exportadas) + bloco `UserPromptSubmit` no `zcode.json` com `"enabled": false`
  (mudança mínima: +16 linhas, 0 remoções).
- `feat(c7): skill voicecast p/ consumir artefatos das sessões` —
  `.zcode/skills/voicecast/SKILL.md` (paths WSL, contrato F0 dos artefatos,
  uso manual do digest, telemetria/kill-switch).
- `test(c7): testes do digest voicecast + fixtures` —
  `scripts/lib/__tests__/voicecast-context-digest.test.mjs` (14 testes) +
  `scripts/lib/__tests__/fixtures/voicecast-session/` (meta.json e
  transcript.json fake, sem segredo).

Evidências (aceite verificável):
- `node --test scripts/*.test.mjs` (raiz): 25/25 verdes — regressão intacta.
- `node --test scripts/lib/__tests__/voicecast-context-digest.test.mjs`: 14/14.
- Smoke manual: sessão fake em tmp (`VOICECAST_SESSIONS_ROOT`) → stdout é
  `{"additionalContext": "<digest markdown>"}` com título/duração/fala/
  julgamento/paths; sem sessão, sessão velha (> janela), raiz inexistente e
  kill-switch `VOICECAST_DIGEST=0` → silêncio, exit 0.
- Payload stdin simulado (formato real do hook): prompt NÃO vaza no digest
  nem na telemetria.
- Telemetria JSONL em `~/.local/state/voicecast-digest.log` (padrão dos
  guardrails, `XDG_STATE_HOME` respeitado): uma linha por rodada com e
  `inject`/`skip`/`error` — SÓ metadados (day, name, ageMin, durationS,
  relevancia, contagens de artefatos, digestChars, ms).

Decisões de implementação (para o gate do mantenedor):
- Saída do hook é `{"additionalContext": …}` e não markdown cru: o runner do
  ZCode só injeta contexto a partir de stdout JSON (stdout não-JSON é
  ignorado; JSON fora do schema marca o hook como falho — docs
  diagnosing-hooks). Sem output ⇒ injeta nada, sem erro.
- Fala no digest só com `meta.jev.relevancia >= 2`; sem julgamento → digest
  só de metadados (leitura estrita do briefing + fail-soft do Jev).
- Bounded: fala ≤ 1000 chars, ≤ 8 prints e ≤ 4 clipes listados (contagem
  total em "(+N mais)").
- Recência = `startedAt + durationS` (fallback mtime do meta.json) dentro de
  `VOICECAST_DIGEST_MAX_AGE_MIN` (default 30); skew de relógio (idade
  negativa no mount do Windows) é aceito.
- Env extras: `VOICECAST_DIGEST_NOW` (now fixo, testes determinísticos) e
  kill-switch `VOICECAST_DIGEST=0` (padrão da casa).

Pendências (torre de controle):
- **Gate humano**: ligar `"enabled": true` no bloco UserPromptSubmit do
  `zcode.json` e validar com sessão real no Windows (`pnpm dev:win`).
- `pnpm test:worktrees` da raiz não pega o teste novo (glob só
  `scripts/*.test.mjs` + `scripts/lib/__tests__/*.test.ts`) — ampliar glob
  num commit de infra (ficou fora do escopo mínimo deste WP).
- Não há sessões reais ainda em `/mnt/c/Users/pedro/AppData/Local/voicecast/sessions`
  nesta máquina — a validação de verdade acontece no gate.

Achados: nenhum bug vizinho relevante.
