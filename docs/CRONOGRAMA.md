# Cronograma — voicecast até o "pronto"

Data: 2026-09-23 · Status: **proposta** (mantenedor ratifica validando a Onda 0)

Consolida o que falta: Etapas 3–5 do [PLANO-JEV-CU](PLANO-JEV-CU.md), M3/M4 da
visão original, pendências da telemetria ([RELATORIO-TELEMETRIA](RELATORIO-TELEMETRIA.md)),
pendência AN.4 do plano de anotações e as issues #3/#4/#5.

## Premissas de ritmo

- Ritmo observado 19–23/09: várias frentes por dia útil, com o mantenedor
  validando no Windows (`pnpm dev:win`) no mesmo dia. **Datas abaixo assumem
  esse ritmo; se cair, as datas deslizam — a sequência e as dependências não.**
- Cada frente fecha com commit + validação no Windows pelo mantenedor (gate
  humano) e relatório em `docs/` quando for marco.
- **Instrumentação acompanha a frente** (ver "Regra transversal" abaixo).
- Itens marcados ⚡ são ortogonais e podem andar em paralelo (inclusive
  delegados a subagents em background).

## Já fechado (não reabrir)

F0 ✅ · M0–M2 ✅ (+ editor fase B 2026-09-23, validação Windows pendente) ·
v2 ditado F9 + ASR hospedado ✅ · Jev E1/E2 ✅ · AN.1/2/6 ✅ · telemetria OTel
ponta a ponta ✅.

---

## Onda 0 — valer o que já está pronto · 23–24/09 (minutos, humano)

| # | Item | Quem |
|---|---|---|
| 0.1 | Validar editor fase B no Windows: segmento, ✂ clipe, exportar corte, "copiar contexto" com seção Trechos | mantenedor |
| 0.2 | Push dos commits pendentes (4 à frente do origin) | mantenedor |
| 0.3 | Checagem visual do dashboard `voicecast` no Grafana (pendência da telemetria) | mantenedor |

## Onda 1 — Metamorfose de harness: voicecast como cockpit do agente · M/L · 23–30/09

> Plano detalhado: **[PLANO-COCKPIT](PLANO-COCKPIT.md)** (WPs C1–C7, teste,
> segurança e decisões a ratificar). FD.0 resolvido (2026-09-23): o engine do
> ZCode é dirigível por **stdio** (`zcode-server.cjs`, protocolo
> `session/create/send/subscribe` + `turn.*` + `permission.respond`) — o
> cockpit aciona agente de primeira classe, sem UIA/colagem (ficam de fallback).

Direção do mantenedor (2026-09-23): a integração almejada **não é "ZCode
consulta o voicecast"** (MCP ficou sem dono por enquanto) — é o **voicecast
subir de gravador a porta de entrada do agente**. ZCode vira o engine atrás.

1. **FD.0 spike — disparar um goal no ZCode programaticamente** (S, primeiro):
   - Caminho limpo: subir o harness (`scripts/opencode-harness.sh start` na
     raiz — server em `127.0.0.1:4096`) e mapear a API de criar sessão /
     submeter prompt. Achado inicial (2026-09-23): o server existe
     (`~/.zcode/server/zcode-server.cjs`), hoje está **down**.
   - Fallback v0 (quase de graça): F9 rota `comando_agente` já cola o goal na
     janela focada do ZCode (E2) + leitura UIA da janela (probe: 381 nós em
     140ms) para acompanhar o desfecho sem digitar nada.
2. **Cockpit v1 na barra/painel**: goal falado → entregue ao engine → estado
   ao vivo na barra (rodando/concluído/erro) → resultado narrado (TTS casa
   com M3; na v1 basta texto na barra).
3. **AN.4**: marcações de anotação (annotations.jsonl + prints queimados) no
   `buildContext` — contexto continua sendo o produto.
4. ⚡ Paralelo: hook `UserPromptSubmit` + skill `.zcode/skills/voicecast/`
   (digest bounded por relevância Jev ≥2) — barato e independe do cockpit:
   quando você trabalha DENTRO do ZCode, o contexto da última sessão chega sozinho.
5. ⚡ Paralelo: **worker thread pro import do SDK OTel** (residual do delay do REC).
6. ⚡ Paralelo (spike 5 min): habilitar plugin oficial `computer-use` do ZCode
   via marketplace (pré-requisito leve da E5).

**Aceite**: falar "abre um PR…" no F9 e o goal rodar num agente de verdade sem
digitar nada, com o desfecho visível na barra.

**MCP de sessões** (`sessions_list`/`session_get`/`sessions_search`/
`latest_context`) → **adiado para a Onda 5** (só ganha dono no fabric
multi-máquina).

## Regra transversal — observabilidade por funcionalidade (mantenedor, 2026-09-23)

**O que rodou, como e o que aconteceu sempre deve ser registrado.** Toda
funcionalidade nova nasce instrumentada (span/métrica/log → collector local):
instrumentação faz parte do aceite da própria frente — não existe "onda de
telemetria" depois do fato. Os serviços (collector/Prometheus/Tempo/Grafana)
já estão de pé; a regra é usá-los em cada entrega.

- Cobertura retro das frentes já existentes (ditado-start, ASR host/boot,
  erros globais): itens pequenos dentro da onda que tocar cada caminho.
- ⚡ Enabler pequeno (qualquer onda): logs do app → Loki (handler OTLP) —
  destrava log como sinal de primeira classe para as frentes seguintes.

## Onda 2 — Produto & dataset: aposentadoria definitiva do voice-dictation · S/M · 29/09–03/10
2. **Issue #5** paridade voice-dictation: fechar o que a migração deixou cair.
3. **Issue #3** dataset de treino: tela de correção/rotulação de ditados no
   voicecast (substitui painel :8700) — último degrau da aposentadoria do daemon.
4. ⚡ Opcional: **Issue #4** WASAPI loopback (áudio do sistema como faixa).
5. Gate: dashboard revisado pelo mantenedor; daemon voice-dictation removido
   das rotinas de boot se #5+#3 fecharem.

## Onda 3 — M3 modo ao vivo + TTS · M · 06–10/10

1. Spike do modo ao vivo (transcrição streaming enquanto grava — o ASR
   hospedado já roda local; decidir janela de partials vs wave-file por marker).
2. UI do modo ao vivo na barra REC (transcrição parcial viva).
3. TTS local (par de ASR: mesma filosofia host-local).
4. Gate: sessão real com transcrição viva + TTS validados no Windows.

## Onda 4 — Jev Etapa 4: computer use no voicecast · L · 13–24/10

Porte Windows do loop voz→percepção→Jev→ação (referência
`awlevin/typesafe-computer-use`). Aceite progressivo já definido no plano:

| Sub | Entrega | Aceite |
|---|---|---|
| FD.1 | Percepção (`cu/perceive.ts`): frame + OCR WinRT + walk UIA → estado textual | loga estado da janela focada |
| FD.2 | Decisão (`cu/decide.ts`): systemone por passo + stall rules | decide certo em cenário fixo |
| FD.3 | Ação (`cu/act.ts`): InvokePattern UIA preferencial, SendInput/koffi fallback | abre URL com kill switch |
| FD.4 | Segurança: gate noul pré-mutação + kill físico + sessão de auditoria | ação mutante bloqueada pelo gate |
| FD.5 | Acionamento por voz/goal + overlay de estado | roteiro de 5 passos gravado |

Depende de E1–E2 ✅. Spikes de FD.1 podem ser puxados p/ Onda 1 se sobrar margem.

## Onda 5 — Jev Etapa 5: fabric multi-máquina + M4 polish · S/M · a partir de 27/10

1. **MCP voicecast** (tools `sessions_list`/`session_get`/`sessions_search`/
   `latest_context`, desenhadas na E3 original) acessível de note/macmini via
   SSH stdio (mcp-peer já registrado nos dois sentidos; `INFRA_MCP_LEVEL=ro`
   de fora).
2. Política de coexistência CUA-Zcode × loop-voicecast documentada + guardrail
   estendido à superfície CUA.
3. s10deck como peer (inventário; captura remota futura).
4. **M4**: hosting ASR no linux/note (hoje só externo via `VOICECAST_ASR_URLS`),
   import externo de mídia, re-sync de relógio do WSL2 (infra).
5. Gate final: do note, `sessions_search` no pchome funcionando num agente real.

## Visão de gantt (dependências)

```
Onda 0 (24/09) ─► Onda 1 cockpit (30/09) ─► Onda 4 E4 (24/10) ─► Onda 5 E5 (out/nov)
                        │
                        └► Onda 2 produto/dataset (03/10) ─► Onda 3 M3 (10/10)
⚡ worker OTel · hook/skill · plugin CUA · WASAPI: qualquer momento da Onda 1 em diante
```

Data-alvo do "pronto" (M3+M4+E3+E4+E5+backlog): **fim de outubro/2026** no ritmo
atual; começo de novembro com margem.

## Fora de escopo (reafirmado do PLANO-JEV-CU)

Streaming/visão no Jev · ditado macOS/Linux · substituir o CUA do ZCode.
