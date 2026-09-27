# C2b — Wiring do runtime headless no runner · pronto

## Objetivo
Tornar DURÁVEL e padrão o desbloqueio provado pelo U2: o runner do voicecast
usa o CLI buildado do open source com um data-dir próprio auto-curado, e um
goal real roda ponta a ponta via `runGoal` (evidência registrada).

## Contexto obrigatório (ler antes)
- `/tmp/zcode-cli-build/BUILD.md` — SEÇÃO "U2 — diagnóstico standalone":
  causa raiz (chave `account-provider:<providerId>:identity` ausente no
  credentials.json), o script idempotente de injeção e o env
  `ZCODE_DATA_BASE_DIR` (cópia do credentials + identity keys; self-heal a
  cada start).
- `/home/pedro/programing/projetos/voicecast/src/main/agent/runner.ts` —
  `agentRunnerConfig`/`goalSpawnArgs` (é aqui que o wiring entra)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- `AGENTS.md` do repo

## Escopo
**Fazer:**
1. Script `src/main/agent/runtime-setup.ts` (puro Node, testável): garante em
   `~/.local/state/voicecast/zcode-runtime/`:
   - `zcode` (binário) + `node24/` copiados de `/tmp/zcode-cli-build/`
     (SE existirem; senão erro claro orientando rodar o U1 — exit code
     distinto p/ pré-requisito ausente);
   - `zcode-data/` com credentials.json copiado de `~/.zcode/v2/` +
     identity keys injetadas (idempotente; re-copia se o mtime do original
     mudar = self-heal se o desktop rotacionar). NUNCA logar segredos;
   - retorna os envs prontos: `ZCODE_DATA_BASE_DIR`,
     `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (se aplicável — conferir no BUILD.md).
2. Runner: `agentRunnerConfig` passa a resolver o binário do runtime setup
   (env `ZCODE_AGENT_BIN` continua sobrescrevendo); spawn direto no Linux
   usa `node24` + binário; Windows segue `wsl.exe` (o script roda dentro do
   WSL — paths WSL, não Windows).
3. Teste LIVE por trás de flag: `tests/agent-live.test.ts` rodando um goal
   real ("Responda somente: ok") via `runGoal` SÓ se
   `VOICECAST_AGENT_LIVE=1` (default CI = skip) — é a prova contínua do C2.
4. Telemetria (DoD): counter `voicecast_agent_runtime_setup_total{resultado}`
   (ok | stale | sem-build) no setup.

**Não tocar:** `~/.zcode` (somente leitura), utilityProcess/barra (C4),
contexto no goal (C3), protocolo do zcode-server.

## Aceite verificável
- `pnpm ci:local` verde (o live test pula por default).
- `VOICECAST_AGENT_LIVE=1 pnpm vitest run tests/agent-live.test.ts` → goal
  "ok" com stdout real, phase=completed (evidência colada no Resultado).
- Unit tests do setup: copia idempotente, self-heal por mtime, erro claro
  sem build, segredos nunca em stdout.

## Riscos e gotchas
- O binário do U1 é esbuild p/ node 24 — spawn SEMPRE com o node24 do
  runtime dir, não o node do sistema.
- Permissões de execução no copiar (chmod +x).
- Credenciais copiadas = arquivo sensível em ~/.local/state — chmod 600 e
  NUNCA imprimir conteúdo.

## Entrega
Commits convencionais (`feat(c2b): …`), sem push. Preencher Resultado abaixo.

## Resultado (preenche o piloto)
- (pendente)
