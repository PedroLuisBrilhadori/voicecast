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

## Onda 1 — Jev Etapa 3: ZCode consumindo voz+tela · M · 23–27/09

O que fecha: "o que eu falei na última sessão?" respondido no ZCode sem arquivo manual.

1. **E3.1 MCP `voicecast`** (stdio, Node puro, padrão mcp-peer): tools
   `sessions_list`, `session_get`, `sessions_search`, `latest_context`; lê
   `%LOCALAPPDATA%\voicecast` do WSL via `/mnt/c`; registro no `zcode.json` da raiz.
2. **E3.2 Hook UserPromptSubmit**: digest da última sessão se < N minutos
   (bounded ~500 tokens, só o que Jev pontuou relevância ≥2).
3. **E3.3 Skill `.zcode/skills/voicecast/`**: como pedir contexto, contrato dos
   artefatos (prints/clipes/transcript ≤30MB).
4. **E3.4 AN.4**: marcações de anotação (annotations.jsonl + prints queimados)
   no `buildContext` e no MCP.
5. ⚡ Paralelo: **worker thread pro import do SDK OTel** (residual do delay do
   REC) — ortogonal, pequeno.
6. ⚡ Paralelo (spike 5 min): habilitar plugin oficial `computer-use` do ZCode
   via marketplace (pré-requisito leve da E5).

## Onda 2 — Telemetria completa + paridade/dataset · S/M · 29/09–03/10

1. logs → Loki (handler OTLP) + cobertura: ditado-start, ASR host/boot, erros
   globais, `clip_seconds`/`cut_seconds` no dashboard.
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

1. MCP voicecast acessível de note/macmini via SSH stdio (mcp-peer já
   registrado nos dois sentidos; `INFRA_MCP_LEVEL=ro` de fora).
2. Política de coexistência CUA-Zcode × loop-voicecast documentada + guardrail
   estendido à superfície CUA.
3. s10deck como peer (inventário; captura remota futura).
4. **M4**: hosting ASR no linux/note (hoje só externo via `VOICECAST_ASR_URLS`),
   import externo de mídia, re-sync de relógio do WSL2 (infra).
5. Gate final: do note, `sessions_search` no pchome funcionando num agente real.

## Visão de gantt (dependências)

```
Onda 0 (24/09) ─► Onda 1 E3 (27/09) ─► Onda 4 E4 (24/10) ─► Onda 5 E5 (out/nov)
                        │
                        └► Onda 2 tel/paridade (03/10) ─► Onda 3 M3 (10/10)
⚡ worker OTel · plugin CUA · WASAPI: qualquer momento da Onda 1 em diante
```

Data-alvo do "pronto" (M3+M4+E3+E4+E5+backlog): **fim de outubro/2026** no ritmo
atual; começo de novembro com margem.

## Fora de escopo (reafirmado do PLANO-JEV-CU)

Streaming/visão no Jev · ditado macOS/Linux · substituir o CUA do ZCode.
