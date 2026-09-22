# Plano — Jev consistente + computer use no voicecast + integração ZCode

Data: 2026-09-21 · Status: **aprovado pelo mantenedor**
Reapresenta o plano truncado da sessão `sess_bc340fad` (marco FJ), agora com a
evidência do discovery 2026-09-21
([probes](../scripts/probes/2026-09-21-discovery/RESULTADOS.md)).

## Decisões já fechadas pelo mantenedor (herdadas, não reabrir)

1. **Fases**: consolidação do cliente Jev + julgamento pós-sessão **primeiro**;
   computer use **depois**.
2. **voicecast hospeda o loop** de computer use (não script externo).
3. Alvo de execução: **Windows/pchome** (port via UI Automation).
4. Consolidar callers Jev em **um cliente + SDK oficial** (`@typesafe-ai/sdk`).
5. Harness alvo: **ZCode** (opencode aposentado) — integração via `zcode.json`
   nativo (MCP stdio, hooks, skills), não via server opencode2.
6. Fabric multi-máquina via padrão **mcp-peer** (pchome-win ↔ note ↔ macmini;
   s10deck futuro) é multiplicador do projeto.

## Evidência que sustenta o plano (probes 2026-09-21, todos passaram)

| Verificado | Resultado |
|---|---|
| Jev `systemone` com choice+2×noul+score sobre transcript | 200 OK · 741ms · rota `comando_agente` 0.98 · risco 0.97 · relevância 2.92/3 |
| Schema atual da API | só `noul\|choice\|score`; `jev-judge.ts` local está em **drift** (`boolean` → 400) |
| OCR WinRT no Windows (interop WSL) | 444ms pt-BR zero-dep, lê tela real |
| UIA da janela do ZCode (Electron) | 381 nós/140ms, 72 InvokePatterns |
| Projeto de referência | `awlevin/typesafe-computer-use` (MIT, macOS): OCR+AX → Jev Choice → ação; adapter único `macos.py` |
| Plugin ZCode `computer-use` | target mac/win/linux; em cache, **não habilitado** |
| F0 (runtime) | Electron escolhido; MP4 ≤30MB p/ Read; DPI 1.53; remux obrigatório |

---

## Etapa 1 — Fundação Jev: um cliente só (workspace) · S

**Objetivo**: eliminar o drift e as 3 implementações paralelas
(`jev-guardrail.mjs`, `jev-judge.ts`, `jev-qa`), criando o cliente canônico.

1. **`scripts/lib/jev-judge.mjs`** — ESM plain (importável por hooks `node`
   puro e por scripts tsx). Por dentro usa `@typesafe-ai/sdk` (retry/tipos);
   por fora mantém a casca da house API (`{state, questions} → respostas`).
   - Correções de schema: sem `boolean` (mapear para noul com criteria
     `{true,false}`); **`choice` novo** (criteria = map opção→descrição;
     resposta `{choice, probabilities, confidence}`); score com criteria
     array ordenado (resposta traz `legend`).
   - Perguntas/políticas e limiares **num arquivo só revisável** (orientação
     da doc oficial da TypeSafe).
   - Telemetria: evento JSONL por chamada (origem, latência, tokens) no padrão
     dos guardrails (`~/.local/state/`) → OTel sidecar → dashboard existente.
   - Fail-loud como hoje (quem chama decide o fallback).
2. **Migrar os 3 callers** para o cliente canônico. Comportamento preservado:
   golden tests dos vereditos atuais do guardrail antes/depois.
3. Testes: `node --test scripts/*.test.mjs` verdes; `jev-calibrate.ts`
   funcionando sobre o cliente novo (regressão de limiar).

**Aceite**: guardrail bloqueia/libera idêntico (golden tests); probe
`jev-systemone-voicecast.mjs` roda via cliente novo com choice; eventos
chegando no dashboard "Agentes · Infra MCP, Guardrail & Perguntas".

**Riscos**: API early-access pode mudar de novo → golden tests + cliente único
tornam o drift visível num lugar só.

## Etapa 2 — Julgamento dentro do voicecast (pós-sessão + F9) · M

**Objetivo**: o app decide com Jev, na hora certa, sem LLM no loop.

1. **`src/main/jev.ts`** — wrapper do app usando `@typesafe-ai/sdk` direto
   (repo próprio tem package.json; key via env da máquina Windows) +
   `src/main/jev-questions.ts` (perguntas versionadas). Métricas OTel
   (`voicecast_jev_seconds`, `voicecast_jev_decisions_total{rota}`).
2. **Pós-sessão** (stop da gravação): uma chamada `systemone` — relevância
   (score 0–3), rota (choice), riscos (noul) — gravada em `meta.json`
   (`campo jev`); alimenta o digest de handoff (o que merece ir ao agente).
3. **F9 ditado** (encaixa no `ditado.ts` existente): após transcrição, rotear
   intenção (choice: `ditado_texto | comando_agente | anotacao_contexto |
   conversa_social`). Confidence gate: ≥0.9 executa rota sozinho
   (`ditado_texto` cola como hoje; `comando_agente` → Etapa 3; `anotacao`
   → anexa à sessão corrente); <0.9 mostra opções na barra do ditado.
4. Testes com fixtures de transcript (unit, sem rede) + 1 teste de integração
   com a API real atrás de flag.

**Aceite**: sessão real produz `meta.json.jev`; ditado "abre um PR…" roteia
`comando_agente`; conversa social não vira handoff; latência p95 do julgamento
< 1.5s no dashboard. **Depende de**: Etapa 1.

## Etapa 3 — Integração ZCode: contexto primeiro · M

**Objetivo**: agente ZCode consumindo voz+tela sem fricção e sem estourar
contexto.

1. **MCP `voicecast`** (stdio, Node puro, padrão mcp-peer, lê
   `%LOCALAPPDATA%\voicecast` — do WSL via `/mnt/c`): tools `sessions_list`,
   `session_get {id}` (meta + digest + transcript), `sessions_search {q}`,
   `latest_context {minutos}`. Registro no `zcode.json` da raiz.
2. **Hook UserPromptSubmit** (padrão dos hooks da casa): injeta digest da
   última sessão se < N minutos (bounded ~500 tokens, respeitando o score de
   relevância da Etapa 2 — só injeta o que Jev pontuou ≥2).
3. **Skill `.zcode/skills/voicecast/`** — como pedir contexto, contrato dos
   artefatos (prints/clipes/transcript ≤30MB, regra F0).
4. (Paralelo, opcional) adaptar a skill oficial TypeSafe
   (`npx skills add typesafe-ai/skills`) para `.zcode/skills/`.

**Aceite**: no ZCode, "o que eu falei na última sessão?" é respondido via MCP
sem arquivo manual; hook injeta digest sem estourar o orçamento de contexto;
runbook da integração no repo. **Depende de**: Etapa 2. Spikes de percepção da
Etapa 4 podem andar em paralelo.

## Etapa 4 — Computer use no voicecast (port Windows) · L

**Objetivo**: loop voz/goal → percepção → Jev decide → ação, hospedado no app,
auditável. Referência: `awlevin/typesafe-computer-use` (adapter `macos.py` →
nosso `src/main/cu/win32`).

1. **FD.1 Percepção** (`src/main/cu/perceive.ts`): frame do
   `desktopCapturer` (já em `capture.ts`) + OCR WinRT (helper PowerShell
   comificado — probe: 444ms) + walk UIA (helper PS/koffi — probe: 381 nós/
   140ms) → **estado textual** (controles nomeados + invocáveis + linhas OCR
   com posições). Cache de tiles como no projeto original (opcional).
2. **FD.2 Decisão** (`src/main/cu/decide.ts`): uma chamada `systemone` por
   passo — choice `kind` (`click_item | use_browser | type_text | scroll |
   press_key | done | none`) + choice `item`; writer opcional p/ texto livre
   (GLM/Haiku — nunca digita senha). Stall rules: confiança <0.4, 2 no-ops,
   limite de passos.
3. **FD.3 Ação** (`src/main/cu/act.ts`): **InvokePattern (UIA) preferencial**
   (não rouba foco — paralelo do AXPress); SendInput via koffi como fallback
   (port do `voice/platform/win32.py`, struct INPUT cbSize 40); scroll/drag.
4. **FD.4 Segurança**: gate noul de risco antes de ação mutante (mesma política
   do guardrail — consistência é o ponto); kill switch físico (mouse no canto,
   como o original) + botão na barra; **toda execução CU é gravada como sessão
   voicecast** (auditoria + dataset).
5. **FD.5 Acionamento**: por voz (F9 → rota `comando_agente` + intent CU) ou
   goal digitado na barra; overlay mostrando estado do loop.

**Aceite progressivo**: FD.1 loga estado textual da janela focada; FD.2 decide
corretamente num cenário fixo; FD.3 abre uma URL no navegador com kill switch
funcionando; FD.5 completa roteiro de 5 passos com gravação da sessão.

**Riscos**: DPI 1.53 (coordenadas em px físicos desde o dia 1 — lição F0);
OCR I/l (UIA complementa); janela errada/ocuso (bind por pid+window_id como o
CUA do ZCode faz); Mimosa guard em paths (literais/sanitizados).

**Depende de**: Etapas 1–2.

## Etapa 5 — Fabric multi-máquina · S/M

**Objetivo**: contexto e ações alcançáveis de qualquer máquina com agente.

1. voicecast MCP acessível de note/macmini via SSH stdio (mesmo desenho
   mcp-peer: registro nos zcode.json das outras máquinas apontando para o
   pchome; `INFRA_MCP_LEVEL=ro` para leitura de fora).
2. s10deck como peer (Termux/ssh) — inventário; mic/câmera como captura
   remota futura.
3. Política de coexistência dos dois CU: **CUA do ZCode** (plugin oficial,
   instalar do marketplace) para tarefas agente-iniciadas; **loop voicecast**
   para voz-iniciadas; `jev-guardrail` estendendo o matcher para a superfície
   CUA (zona cinza de mutação de UI) — mesma telemetria.

**Aceite**: do note, agente consulta `sessions_search` do voicecast no pchome;
política de CU documentada em runbook; plugin `computer-use` do ZCode
instalado e com `computer.target` verificado na topologia
desktop-attached-remote. **Depende de**: Etapas 3–4 (spike do plugin é
independente e pode ocorrer cedo).

---

## Sequência e paralelismo

```
E1 ──► E2 ──► E3 ─────────────► E5
           └───► E4 (FD.1→FD.5) ─┘   (spikes FD.1 paralelos a E3; plugin CUA: qualquer momento)
```

Tamanho relativo: E1 S · E2 M · E3 M · E4 L (sub-marcos FD.n) · E5 S/M.
Cada etapa fecha com relatório na pasta `docs/` (padrão RELATORIO-F0) e, quando
houver aprendizado durável, nota no vault via skill `capturar-nota`.

## Fora de escopo (por enquanto)

- Streaming/visão no Jev (a API não aceita imagem; o design já contorna).
- Ditado no macOS/Linux (foco pchome-win; adapter isolado deixa porta aberta).
- Substituir o CUA do ZCode pelo loop voicecast (coexistência, papéis distintos).
