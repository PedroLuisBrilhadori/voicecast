# W2b — Backlog técnico da Onda 1 (achados vizinhos acumulados) · pronto

## Objetivo
Fechar os 4 achados vizinhos que os pilotos da Onda 1 anotaram e a torre
enfileirou — todos pequenos, todos com dono agora.

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/docs/DELEGACAO.md` (protocolo)
- `AGENTS.md` do repo
- Os itens (referências nos briefings de origem):
  1. **runner ignora `req.cwd` no caminho Windows** — briefing C4 (Resultado);
     `src/main/agent/runner.ts`: no spawn wsl.exe o cwd vai undefined; o goal
     precisa rodar no diretório pedido (passar `--cwd <dir>` pro CLI headless
     via o script sh -lc, resolvendo o path p/ WSL; nunca interpolado no argv
     — vá por ENV como o goal).
  2. **`goalSummary` duplicado** (runner.ts e agent-goal.ts) — mesmo briefing;
     manter UMA fonte (shared/agent-goal.ts) e re-exportar.
  3. **`idle+15s` do init de telemetria ficou desnecessário pós-W1** — briefing
     W1 (Resultado); `src/main/index.ts` ainda adia o init para não travar o
     event loop, mas o SDK agora roda em worker_thread; encurtar o delay (e
     manter o teste do W1 verde).
  4. **`fmtTs` arredonda t≈59.7 como "0:60"** — briefing C6 (Achados);
     `src/shared/` (fmtTs movido pelo C6); arredondar para o próximo minuto
     corretamente (`1:00`) e ajustar/estender o teste.

## Escopo
**Fazer:** os 4 itens acima, cada um com teste/ajuste de teste. Nada além.
**Não tocar:** contrato IPC (exceto nada), captura, editor, bar, dataset (W2a
está em paralelo NOUTROS arquivos — não mexer em EditorApp/library.ts).

## Aceite verificável
- `pnpm ci:local` verde; testes novos/ajustados por item (4 grupos).
- Evidência do item 1: teste do spawn args no caminho windows (goalSpawnArgs)
  contendo o cwd resolvido.

## Riscos e gotchas
- O item 1 é o que o gate `--agenttest` do mantenedor vai exercer no Windows —
  paridade WSL/Windows do caminho de spawn obrigatória (teste cobre os dois).
- Item 3: não encostar no desenho do worker (W1) — só o agendamento do init.

## Entrega
Commits convencionais (`fix(w2b): …` um por item), sem push. Preencher Resultado.

## Resultado (preenche o piloto)
**Entregue 2026-09-29 — 4/4 itens, `pnpm ci:local` verde (185 testes passando,
0 falhas; 4 skipped = smokes sob pedido). Commits (sem push):**

1. **req.cwd no caminho Windows** — fe4b44c. `goalSpawnArgs` ganha `cwd`: no
   Windows o path é resolvido p/ WSL (`winPathToWsl`, shared/paths.ts) e vai
   por ENV `VOICECAST_CWD` — nunca interpolado no argv do wsl.exe (mesmo
   contrato do goal). Os dois scripts WSL (legado e runtime) fazem `cd` no
   início com guarda p/ vazio e exit 86 distinto (87 segue = pré-requisito).
   Direto segue com o cwd do spawn. *Testes:* goalSpawnArgs windows nos dois
   modos (runtime/legado) com `C:\...` → `/mnt/c/...` no ENV, path ausente do
   argv e `cd`/exit 86 no script; runGoal com `FAKE_PWD` no fake-agent prova o
   cwd no caminho direto/WSL (paridade dos dois caminhos coberta).
2. **goalSummary dedupe** — d45e2a6. Fonte única em shared/agent-goal.ts; a
   cópia do runner.ts saiu e virou re-export. *Teste:* identidade de função
   (`goalSummaryDoRunner === goalSummaryDaFonte`).
3. **idle+15s do init de telemetria** — 50096f3. Agendamento extraído p/
   `src/shared/telemetry-schedule.ts` (puro): delay inicial 15s → **2s**
   (pós-W1 o SDK roda em worker_thread; init não bloqueia o event loop),
   guarda de idle mantida (retry 5s). index.ts só consome — desenho do worker
   (W1) intocado; testes do W1 (bridge + worker real) verdes. *Testes:* fake
   timers (dispara em 2s com idle; adia em retry enquanto gravação ativa).
4. **fmtTs "0:60"** — bb0afcd. Arredonda o TOTAL de segundos antes de quebrar
   m:ss. *Testes:* 59.7→"1:00", 59.4→"0:59", 119.5→"2:00" (+ regressão
   existente intacta).

**Nada tocado:** EditorApp/library.ts/ditado.ts (W2a), captura, contrato IPC,
desenho do worker W1 (só o agendamento do init). Achados novos: nenhum.
**Pendências/gates:** validação do mantenedor no Windows (`pnpm dev:win` +
`--agenttest`) — o item 1 é exercido de verdade só lá (exit 86 p/ cwd
inacessível aparece no stderr do goal).
