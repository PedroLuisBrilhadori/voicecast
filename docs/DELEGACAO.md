# Delegação — subagents pilotando WPs do voicecast

Data: 2026-09-27 · Mantém a regra da casa: **torre de controle** (sessão main
+ mantenedor) decide direção e valida gates; **pilotos** (subagents) entregam
WPs fechados.

## Protocolo do piloto (toda delegação segue isto)

1. **Leia antes de codar** (nesta ordem): o briefing do WP
   (`docs/wp/<id>.md`) · `AGENTS.md` do repo · os docs canônicos que o
   briefing citar. O briefing é autocontido — se algo essencial faltar,
   **pare e reporte**; não invente.
2. **Escopo estrito**: só o que o briefing manda. Achei bug vizinho? Anote
   na seção "Achados" do briefing — não conserte por conta própria.
3. **Definition of Done** (sem isso o WP não está entregue):
   - `pnpm ci:local` verde (typecheck + testes + build);
   - **instrumentação nasce junto** (regra do mantenedor: span/métrica/log
     da feature no mesmo commit — ver "Regra transversal" do CRONOGRAMA);
   - testes novos cobrindo o comportamento do WP;
   - commits pequenos e convencionais (`feat(c6): …`) — sem push;
   - briefing atualizado com resultado, achados e pendências.
4. **Proibições do piloto**:
   - NUNCA `pnpm dev:win`, sync-to-host, ou qualquer coisa na cópia Windows;
   - NUNCA reabrir decisão fechada (arquitetura Electron, protocolo do
     cockpit, permissões leitura-auto/mutação-humana, etc.);
   - NUNCA mexer fora dos paths listados no briefing;
   - NUNCA push, deploy, ou mudança em config do usuário/máquina.
5. **Reporte final**: o que entregou, evidências (testes/commits), o que
   ficou pendente e por quê.

## Estado dos WPs (torre de controle mantém)

| WP | Onda | Estado | Paralelizável com |
|---|---|---|---|
| [U1 — build do CLI open source](wp/U1-build-cli.md) | 1 | ✅ **build ok** / goal pendente (registry standalone sem modelos → follow-up U2) | — |
| U2 — diagnosticar síntese de account providers no boot standalone | 1 | 🚀 piloto em background | W1 (repo só leitura) |
| [C6 — AN.4: anotações no buildContext](wp/C6-an4-buildcontext.md) | 1 | ✅ **entregue** (d0c7c3f..46a5afb; 103 testes; gate Windows pendente) | — |
| [W1 — worker thread p/ import OTel](wp/W1-worker-otel.md) | 1 ⚡ | ✅ **entregue** (331e35b; 114 testes; API main intacta; gate Windows pendente) | — |
| [C7 — hook + skill .zcode](wp/C7-hook-skill.md) | 1 ⚡ | ✅ **entregue** (39 testes; hook `enabled:false` — gate: ligar + validar c/ sessão real no Windows) | — |
| C2-unlock — validar goal headless de verdade | 1 | bloqueado: depende de U1 | — |
| [C3 — contexto no goal](wp/C3-contexto-goal.md) | 1 | briefing pronto (executa pós-U1) | C7 |
| [C4 — cockpit na barra (utilityProcess+IPC)](wp/C4-cockpit-barra.md) | 1 | briefing pronto (executa pós-U1) | C3 (serial no repo) |
| C5 — gate de permissão local | 1 | bloqueado: C4 | — |
| Onda 2 (#5 paridade, #3 dataset, #4 WASAPI) | 2 | rascunho (briefing ainda não escrito) | — |

## Template de briefing (`docs/wp/<ID>-<slug>.md`)

```
# <ID> — <título> · <estado>
## Objetivo (1–2 frases, no vocabulário do produto)
## Contexto obrigatório (paths absolutos p/ ler antes)
## Escopo: fazer / não tocar
## Aceite verificável (comandos + efeitos observáveis)
## Instrumentação exigida (nomes de métricas/spans)
## Riscos e gotchas do repo
## Entrega (commits, seção Resultado preenchida no fim)
## Resultado (preenche o piloto)
```

## Como a torre orquestra

- Pilotos rodam como **agents em background** (paralelos quando a coluna
  "Paralelizável" permitir); a sessão main segue em outras frentes.
- Gate humano (mantenedor) no fim de cada onda: validação no Windows via
  `pnpm dev:win` — piloto nunca valida sozinho no Windows.
- Resultado de piloto = commits no repo + briefing preenchido; a torre
  confere ci:local e fecha o WP.
