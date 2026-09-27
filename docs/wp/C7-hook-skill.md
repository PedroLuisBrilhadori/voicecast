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
- (pendente)
