// Probe v2: schema correto da API TypeSafe (noul/choice/score) — cenário voicecast.
// Diferenças vs jev-judge.ts local: sem "boolean" (API não aceita), noul.criteria
// é {true,false}, choice.criteria é map opção→descrição, score.criteria é array ordenado.
import { readFileSync } from "node:fs";
const key = readFileSync("/home/pedro/programing/projetos/.env", "utf8").match(/^TYPESAFE_API_KEY=(\S+)/m)[1];

const t0 = performance.now();
const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
  signal: AbortSignal.timeout(15000),
  body: JSON.stringify({
    model: "jev-latest",
    state: {
      origem: "voicecast — sessão voz+tela (transcript ASR local, word timestamps)",
      projeto: "unidocs",
      transcript: `[00:12] cara, olha esse dashboard do grafana aqui, o painel de latência tá mostrando um pico absurdo desde ontem à noite, tipo 3 segundos de p99
[00:31] acho que foi aquele deploy da versão 2.4 que a gente fez, mexeu no módulo de billing
[00:48] quero que você abre o repo unidocs, olha o diff do deploy de ontem e me diz se mudou alguma query sem índice
[01:10] não mexe em nada não, só analisa e me responde`,
    },
    questions: {
      rota_f9: {
        type: "choice",
        instructions: "Rotear a entrada de voz do usuário capturada pelo voicecast.",
        criteria: {
          ditado_texto: "Usuário quer texto colado na janela focada (ditado puro)",
          comando_agente: "Usuário está pedindo uma tarefa para o agente de código executar",
          anotacao_contexto: "Contexto/observação para guardar e associar à sessão, sem ação imediata",
          conversa_social: "Fala dirigida a outra pessoa ou pensamento solto, ignorar",
        },
      },
      pedido_de_acao: {
        type: "noul",
        instructions: "O transcript contém um pedido direto para o agente executar uma tarefa (analisar, editar, rodar, responder)?",
        criteria: { true: "Pedido explícito dirigido ao agente/assistente", false: "Só conversa/observação, sem pedido" },
      },
      risco_da_acao: {
        type: "noul",
        instructions: "A tarefa pedida é somente-leitura e reversível (não muta código, infra nem dados)?",
        criteria: { true: "Só ler/diffar/consultar e responder", false: "Envolve editar, deployar, deletar ou mutar algo" },
      },
      relevancia_contexto: {
        type: "score",
        instructions: "Relevância deste transcript como contexto para a próxima tarefa de código do agente.",
        criteria: ["Conversa sem relação com código", "Contexto geral do projeto", "Contém pista útil: sintoma, suspeita ou módulo", "Tarefa acionável com critérios claros"],
      },
    },
  }),
});
const ms = (performance.now() - t0).toFixed(0);
const body = await res.json();
console.log(`HTTP ${res.status} · ${ms}ms`);
console.log(JSON.stringify(body, null, 2));
