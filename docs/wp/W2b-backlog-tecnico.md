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
- (pendente)
