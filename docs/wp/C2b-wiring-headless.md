# C2b — Wiring do runtime headless no runner · ✅ entregue (goal live ok)

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

**ENTREGUE (2026-09-27, piloto C2b).** `pnpm ci:local` verde (133 testes, live
pulando por default) e o goal REAL respondeu ponta a ponta via `runGoal`.

### Evidência LIVE (obrigatória)

`VOICECAST_AGENT_LIVE=1 pnpm vitest run tests/agent-live.test.ts` (primeiro
run; a duração inclui a materialização inicial do runtime — 229 MB):

```
[live-c2b] {"phase":"completed","exitCode":0,"durationMs":46976,"agentBin":"/home/pedro/.local/state/voicecast/zcode-runtime/zcode"}
[live-c2b] stdout: "ok\n"
✓ tests/agent-live.test.ts (1 test) 46982ms
```

Estado observável pós-run (verificado sem imprimir segredos):
- `~/.local/state/voicecast/zcode-runtime/` materializado: `zcode` (755),
  `node24/` (bin 755), `provider/zcode-builtin.json`, `zcode-data/` (700) com
  `credentials.json` (600) — 8 chaves (6 do desktop + 2 identity injetadas).
- `~/.zcode/v2/credentials.json` INTACTO: 6 chaves, 0 identity (somente
  leitura respeitado). O CLI escreveu `telemetry-state.json` dentro do
  data-dir próprio (comportamento do `ZCODE_DATA_BASE_DIR`, já anotado no U2)
  e logs/db normais em `~/.zcode/cli/` (precedente U1/U2).

### O que foi implementado

1. `src/main/agent/runtime-setup.ts` (puro Node, sem electron): `ensureRuntime`
   idempotente com self-heal por mtime — copia `zcode`+`node24/`+provider do
   build U1 para `~/.local/state/voicecast/zcode-runtime` (paths por env
   `VOICECAST_ZCODE_BUILD_DIR`/`VOICECAST_RUNTIME_DIR`), monta
   `zcode-data/.zcode/v2/credentials.json` (600) com `injectIdentityKeys`
   (regex do U2: `account-provider:<providerId>:identity` = UUID do nome da
   api-key; idempotente), devolve os envs prontos (`ZCODE_DATA_BASE_DIR`,
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
   quando existe). Cache por processo (`ensureRuntimeCached`) — self-heal 1x
   por start do bridge. Counter
   `voicecast_agent_runtime_setup_total{resultado}`.
2. `src/main/agent/runner.ts`: `agentRunnerConfig` resolve o binário do
   runtime (env `ZCODE_AGENT_BIN` continua sobrescrevendo E desligando o
   runtime setup — compat com o comportamento antigo); spawn direto Linux é
   `<node24/bin/node> <zcode> -p <goal>` com os envs do setup; Windows segue
   `wsl.exe --exec sh -lc` com script single-line que garante binários (cp do
   build), roda o self-heal de credentials DENTRO do WSL via
   `node24 -e "$VOICECAST_SETUP_JS"` (mesma lógica, paridade garantida por
   teste) e exec no node24 do runtime — paths `$HOME` (WSL), nunca Windows.
   `runGoal` falha claro quando o setup falha (erro do pré-requisito vira
   goal failed com a mensagem orientando o U1).
3. Testes: `tests/runtime-setup.test.ts` (16 — cópia idempotente, self-heal
   por mtime → resultado `stale`, durável sem buildDir, `SEM_BUILD`/
   `SEM_CREDENCIAL`, segredos nunca em stdout, paridade do JS de self-heal
   incluindo exit 87) e `tests/agent-runner.test.ts` (12 — defaults do
   runtime, override, spawn node24+binário, script WSL com exit 87 e goal só
   por ENV) + `tests/agent-live.test.ts` (live por trás de
   `VOICECAST_AGENT_LIVE=1`, default skip).

### Decisões e desvios conscientes (para a torre validar)

- **Counter**: além de `ok | stale | sem-build`, nasceu `sem-credencial`
  (credentials do desktop ausentes = usuário sem login) — falha real que não
  é "sem build"; taxonomia do briefing estendida por honestidade.
- **Durabilidade**: se o runtime dir já está completo, o buildDir NÃO é
  exigido (sobrevive a reboot que limpa /tmp); o build só é necessário para
  materializar/refresh. Build mais novo que a cópia (mtime/size) → refresh e
  resultado `stale`.
- **`stale`** = qualquer re-cópia sobre material existente (credentials
  rotacionados OU rebuild do U1). Primeira provisionação e "nada a fazer" =
  `ok`.
- **Windows**: o self-heal de credentials dentro do WSL usa
  `VOICECAST_SETUP_JS` via env do spawn (mesmo mecanismo do `VOICECAST_GOAL`
  do C2). O hop wsl.exe→WSL segue o padrão já adotado no C2 e continua sob o
  gate humano de validação no Windows (`pnpm dev:win`) — piloto não valida
  Windows.
- Sem utilityProcess/barra (C4 intocado), sem contexto no goal (C3 intocado),
  protocolo do zcode-server intocado.

### Pendências / achados

- Gate humano: validação no Windows via `pnpm dev:win` (spawn wsl.exe +
  self-heal dentro do WSL).
- `telemetry-state.json` do CLI aparece no data-dir próprio (comportamento
  do `ZCODE_DATA_BASE_DIR` confirmado em runtime — nota do U2 validada).
- Achado vizinho (não consertado, escopo estrito): o live gastou ~47s no
  primeiro run por causa da cópia de 229 MB síncrona no event loop do main
  (fs/promises — threadpool, mas o ensure é `await` dentro do primeiro
  goal). Runs seguintes são stat-only + goal (~7s no U2). Se incomodar,
  candidata a worker (padrão W1) em WP futuro.
- Durabilidade do build: `/tmp/zcode-cli-build` some no reboot; com o runtime
  já materializado isso NÃO quebra (testado), mas o refresh de binários
  (rebuild do U1) só funciona com o build presente de novo.
