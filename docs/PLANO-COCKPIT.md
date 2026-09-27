# Plano — Cockpit de voz: voicecast como porta de entrada do agente (Onda 1)

Data: 2026-09-27 · Status: **ratificado pelo mantenedor** (decisões abaixo)
Referências: [CRONOGRAMA](CRONOGRAMA.md) Onda 1 · [PLANO-JEV-CU](PLANO-JEV-CU.md)
Etapa 2 (rota `comando_agente`) · [RELATORIO-E2](RELATORIO-E2.md)

## Descoberta FD.0 (2026-09-27) — o engine é dirigível, sem hacks

O ZCode Desktop roda um server próprio — `~/.zcode/server/zcode-server.cjs`
com node dedicado (`~/.zcode/server/node`) — e conversa com ele **por pipes
stdio** (não há porta HTTP; confirmado no processo vivo). O protocolo extraído
do bundle em produção expõe, entre outros:

```
initialize · session/create · session/send · session/list · session/read ·
session/stop · session/goal · session/subscribe · session/events ·
session/messages · session/fork · session/resume · session/compact ·
turn.started · turn.completed · turn.failed · state.updated ·
permission.respond · elicitation.respond · model.set · mode.set · workspace.set
```

**Consequência**: o voicecast (main Electron, Node) pode spawnar o server e
falar o MESMO protocolo do Desktop — acionamento de agente de primeira classe,
sem colar texto nem ler UIA (que ficam só de fallback). Nada de server
opencode2/4096: decisão #5 do PLANO-JEV-CU segue de pé (harness alvo = ZCode).

Detalhe de ambiente: o server roda no WSL; o voicecast roda no Windows. O
spawn atravessa `wsl.exe -e <node> <server.cjs>` — pipes stdio passam ilesos
(mesmo mecanismo que o Desktop usa hoje na ponte Windows↔WSL).

## Objetivo / não-objetivos

**Objetivo**: falar um goal no F9 (rota `comando_agente`) e ele executar num
agente ZCode de verdade — sem digitar — com estado ao vivo na barra, gate de
permissão local e desfecho auditável na sessão voicecast.

**Não-objetivos**: embutir UI do ZCode no voicecast; substituir o CUA do
ZCode; multi-máquina (isso é Onda 5); TTS (M3, depois).

## Arquitetura

```
F9 (voz) → ditado → ASR → Jev rota comando_agente (conf ≥0.9)
   └─► src/main/agent-bridge.ts (NOVO)
         ├─ spawn zcode-server via wsl.exe (stdio; 1 goal por vez)
         ├─ initialize → session/create (mode/model padrão)
         ├─ session/send(goal + contexto bounded da última sessão)
         ├─ session/subscribe → turn.* → estados na barra (broadcast)
         ├─ permission.respond ← gate local (política do guardrail)
         └─ turn.completed → desfecho → barra + meta.json.agentGoals[]
```

## Work packages

### C1 — Probe do protocolo (S) · primeiro, destrava tudo
Script standalone em `scripts/probes/2026-09-23-acp/` (padrão discovery):
spawn do server pelo WSL, `initialize`, `session/create`, envio de goal mínimo
("responda só: ok"), leitura de `turn.completed`. Documenta os schemas reais
(request/response) do subconjunto que o bridge usa, no RESULTADOS.md do probe.
**Aceite**: goal mínimo executa ponta a ponta e a troca de mensagens fica
logada (JSONL). Não gasta nada além de uma sessão de teste.

### C2 — `agent-bridge` em utilityProcess (M) · o coração
Encapsula o ciclo spawn → initialize → session/create → send → subscribe →
stop, com timeout, fila de 1 goal por vez e teardown no quit. Roda em
**utilityProcess** (decisão ratificada): crash do bridge não derruba
gravação/ditado; o main só vê o contrato do bridge (messages port). Paths do
server/node configuráveis (`ZCODE_SERVER_*`), kill-switch `VOICECAST_AGENT_BRIDGE=0`.
Testável com server **fake** por stdio (fixtures de `turn.*`).
**Instrumentação (DoD)**: spans `agent.goal`; counters
`voicecast_agent_goals_total{desfecho}`; histograma `voicecast_agent_goal_seconds`.
**Aceite**: unit verde com server fake; `--agenttest "goal de teste"`
determinístico no Windows (novo gancho, padrão `--autotest`).

### C3 — Contexto no goal (S)
O goal leva o `buildContext` bounded da última sessão (se < N minutos e
relevância Jev ≥2 — a mesma política desenhada p/ hook). Reusa `buildContext`,
trunca em ~2k tokens, cita paths de artefatos.
**Instrumentação**: `voicecast_agent_context_total{com,sem}`.
**Aceite**: goal após uma sessão recente cita o contexto; goal frio não carrega nada.

### C4 — Cockpit v1 na barra/painel (M) · o que você vê
Estados no BarApp (complementando `ditado-state`): `idle → ouvindo →
roteando → rodando(goal, com resumo dos turnos) → concluído | erro`. Entrada
alternativa digitada no painel (sem voz). Desfecho persistido em
`meta.json.agentGoals[]` da sessão corrente (liga voz↔agente na auditoria).
**Aceite**: falar "abre um PR…" e acompanhar o ciclo na barra sem digitar.

### C5 — Gate de permissão local (M) · segurança da casa
Quando o server pedir `permission.respond`, o bridge consulta o gate Jev
local (`jev-questions`, mesma política do guardrail): leitura auto-aprovada,
mutação de zona cinza → confirmação humana na barra (ou bloqueio direto, se
risco alto). Segredo nunca vai no goal (Jev já pontua risco).
**Instrumentação**: `voicecast_agent_permissions_total{decisão}`.
**Aceite**: goal que tenta comando bloqueado pelo guardrail é negado sem
intervenção de digitação; leitura flui sozinha.

### C6 — AN.4: anotações no buildContext (S)
Marcações (`annotations.jsonl` + prints queimados) entram como linhas de
contexto no `buildContext` — fecha a pendência do plano de anotações.

### C7 — ⚡ paralelos (não bloqueiam)
Hook `UserPromptSubmit` + skill `.zcode/skills/voicecast/` (digest bounded no
ZCode quando você trabalha lá dentro) · worker thread p/ import do SDK OTel ·
spike do plugin `computer-use`.

## Segurança

Permissão julgada localmente (C5) · goals e desfechos auditados na sessão ·
kill-switch do bridge · nenhum segredo no goal (política Jev existente).

## Testes

Unit (WSL, sem rede): bridge × server fake stdio; gate; contexto bounded;
contrato IPC novo (estado do agente p/ barra). Smoke Windows: `--agenttest`.
CI segue `pnpm ci:local`.

## Decisões ratificadas pelo mantenedor (2026-09-27)

1. **Workspace (cwd) dos goals**: por **diferentes diretórios** — selecionável
   por goal (falado/ digitado), com default no último usado. O painel do
   cockpit oferece a lista; o goal pode nomear o alvo.
2. **Mode/model**: **config explícito do voicecast** (arquivo próprio em
   `%APPDATA%\voicecast\agent.json`, não herda settings do ZCode); overridável
   por goal.
3. **Permissão**: auto-aprovar leitura, exigir humano para mutação (espelha o
   guardrail).
4. **Onde roda o bridge**: **utilityProcess** (isolamento de crash — queda do
   bridge não derruba gravação/ditado).

## Sequência e estimativa

```
C1 (probe) → C2 (bridge) → C3 ∥ C4 → C5 → C6      ⚡ C7 o tempo todo
```
~2–3 sessões de agente + 2 gates humanos (validação Windows). Tudo
instrumentado por WP (regra transversal do cronograma).
