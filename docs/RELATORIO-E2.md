# Relatório Etapa 2 (MVP) — Julgamento Jev dentro do voicecast

Data: 2026-09-21 · Plano: [PLANO-JEV-CU.md](./PLANO-JEV-CU.md) · Anterior:
[RELATORIO-E1.md](./RELATORIO-E1.md) (fundação no workspace)

## Resumo

| Item | Veredito |
|---|---|
| `src/main/jev.ts` + `jev-questions.ts` (SDK oficial, fail-soft, métricas OTel) | ✅ |
| F9 roteia intenção ANTES de colar (`decidePaste`) | ✅ tabela-verdade testada |
| Barra do ditado mostra o desfecho (não-colar precisa se explicar) | ✅ |
| Sessão finalizada ganha `meta.json.jev` + linha no `buildContext` | ✅ |
| Testes unit (mock, sem rede) | ✅ 23 passaram (14 do jev) |
| Smoke com API real | ✅ 3/3 (747ms comando, 731ms ditado) |
| `pnpm ci:local` (typecheck + vitest + build) | ✅ |
| Sync Windows reinstala deps quando `package.json` muda | ✅ (senão o SDK faltaria no host) |

## O que o MVP faz

1. **F9 inteligente**: após o ASR, uma chamada `systemone` (choice, ~700ms)
   roteia o ditado. `ditado_texto` → cola como sempre. **`comando_agente`,
   `anotacao_contexto` e `conversa_social` com confiança ≥ 0.9 NÃO são
   colados** na janela focada — a barra mostra o desfecho ("→ agente (não
   colado)", "✎ guardado na sessão", "— conversa (ignorada)") por ~2,2s antes
   de fechar. Confiança < 0.9 cola (não decide sozinho). Sem key/off/erro →
   cola exatamente como antes (fail-soft — julgamento é melhoria, não
   dependência).
2. **Sessão julgada**: no fim da transcrição, 4 perguntas numa chamada (~750ms)
   → `meta.json.jev = { model, judgedAt, rota, conf, relevancia, pedido, risco }`.
   O "Copiar para o ZCode" (`buildContext`) inclui a linha
   `Julgamento (Jev …): rota … · relevância …/3 · pedido-de-ação … · risco …`
   — triagem pronta para o agente consumir (Etapa 3 usará o campo `rota`
   `comando_agente` pendente).
3. **Observabilidade**: `voicecast_jev_decisions_total{origem,status}` e
   `voicecast_jev_seconds{origem}` no OTel existente; logs no main.log.

## Arquivos

- Novos: `src/main/jev.ts`, `src/main/jev-questions.ts`, `tests/jev.test.ts`,
  `tests/jev.smoke.test.ts`.
- Mudados: `src/main/ditado.ts` (julgamento + decidePaste + desfecho na
  barra), `src/main/library.ts` (`meta.jev` + julgamento pós-transcrição +
  linha no buildContext), `src/shared/ipc.ts` (evento `ditado-state` ganha
  `phase:"done"` + `rota/conf/colado`), `src/renderer/BarApp.tsx` (desfecho),
  `scripts/sync-to-host.ps1` (reinstall por hash do package.json),
  `package.json` (dep `@typesafe-ai/sdk`), `AGENTS.md`, `tests/ipc-contract.test.ts`.

## Setup no Windows (uma vez, pelo mantenedor)

1. `pnpm dev:win` — o sync agora reinstala deps sozinho (marcador `.deps-hash`).
2. Key do Jev: `echo <TYPESAFE_API_KEY> > %APPDATA%\voicecast\jev-key.txt`
   (ou exportar `TYPESAFE_API_KEY` no ambiente do app).
3. Testar: F9 + "abre um pull request…" → barra mostra "→ agente (não
   colado)"; F9 + texto de e-mail → "✓ colado"; encerrar uma sessão →
   `meta.json` com campo `jev`.

## Verificações

- Unit (sem rede): `pnpm test` → 23 passaram (fixtures = respostas reais do
  probe; tabela-verdade do `decidePaste` é o contrato de UX do F9).
- Smoke (API real, jev-1.13.0): comando → `comando_agente` 747ms;
  ditado puro → `ditado_texto` 731ms; sessão → relevância >1.5, risco
  somente-leitura alto. Rodar de novo:
  `VOICECAST_JEV_SMOKE=1 TYPESAFE_API_KEY=<key> pnpm vitest run tests/jev.smoke.test.ts`

## Validação REAL no Windows (2026-09-21/22) ✅

Setup executado: build WSL → sync (reinstalou deps: `added 1 package`) → key
em `%APPDATA%\voicecast\jev-key.txt` (via stdin) → app real no Windows.

| Teste | Resultado |
|---|---|
| F9 ramo colar (conf < 0.9) | `2134-c56ac751`: colou 60 chars + `jev: rota comando_agente conf 0.88` — gate de confiança agiu como projetado |
| **F9 ramo supressão** (conf ≥ 0.9) | `2137-190dcb89`: log `ditado: NÃO colado — rota comando_agente (conf 0.99)`, **nenhum paste**, `meta.jev {rota comando_agente, conf 0.99}`, barra sem erro |
| Sessão com tela (`--autotest` 11,7s + marker) | `2137-9e85f08f`: ASR real (cuda, 19 palavras — TTS falado no mic) → `--transcribe` headless → **`meta.jev` completo** `{rota ditado_texto conf 0.28 · relevância 0.19 · pedido 0.72 · risco 0.52}` em 771ms |
| Jev com input imperfeito | transcript fragmentar → confiança BAIXA registrada (dúvida calibrada é feature) |

Notas da validação:

- "Comando falado" do F9 usado via `VOICECAST_DITADO_FAKE_TEXT` (pula o ASR;
  a fala REAL no mic foi exercitada na sessão com TTS). Novo gancho
  **`--ditado-test`** (index.ts): start→6s→stop sem tecla física, mesmo
  estilo do `--autotest` — os dois viram a via padrão de validar no Windows.
- `SendKeys`/tecla física não pôde ser usada pelo agente (UIPI "Acesso negado"
  + hotkey global não disparou com input sintético) — por isso os ganchos.
- **Bug achado e corrigido durante a validação**: react 19.2.7 +
  react-dom 19.3.0 no lockfile → React error #527 (barra em branco em
  runtime). Alinhado: `react-dom@19.2.7` exato; bundle voltou a ter UMA
  versão de React.
- Estado final da máquina: app encerrado (dev instance), F9 devolvido ao
  daemon, sem processos restantes. Key permanece em
  `%APPDATA%\voicecast\jev-key.txt` (desejado).

## Pendências / próximos

- ~~Run real no Windows~~ **VALIDADO** (seção acima) — restam: um teste do
  mantenedor falando de verdade no F9 (voz humana, sem fake text) e o visual
  da barra com o desfecho em uso normal.
- `comando_agente` ainda não tem consumidor → **Etapa 3** (MCP voicecast +
  hook UserPromptSubmit) usa o campo `jev.rota` do meta.
- Guardrails do workspace estão OFF por marcador (desde 19/09) — independente
  desta etapa, religar é decisão do mantenedor.
