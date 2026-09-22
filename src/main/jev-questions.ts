/**
 * Perguntas e limiares Jev do voicecast — arquivo único revisável
 * (espelho do padrão do workspace: scripts/lib/jev-questions.mjs; aqui os
 * textos vêm do probe validado em 2026-09-21, ver docs/RELATORIO-E1.md).
 *
 * Não editar os textos sem revalidar com o smoke test
 * (VOICECAST_JEV_SMOKE=1 pnpm vitest run tests/jev.smoke.test.ts).
 */

/** Rotas possíveis de uma entrada de voz (opções do choice — decidePaste depende delas). */
export const ROTAS = ["ditado_texto", "comando_agente", "anotacao_contexto", "conversa_social"] as const;
export type Rota = (typeof ROTAS)[number];

/** Acima desta confiança a rota é executada sozinha; abaixo, cola como ditado. */
export const AUTO_CONFIDENCE = 0.9;

/** F9 espera a resposta (antes de colar): orçamento curto, 1 tentativa. */
export const JEV_TIMEOUT_DITADO_MS = 4000;
/** Sessão é julgada em background: orçamento folgado. */
export const JEV_TIMEOUT_SESSAO_MS = 15000;

/** Roteamento de intenção do ditado F9 (choice — a pergunta rápida do caminho quente). */
export const Q_ROTA = {
  type: "choice",
  instructions: "Rotear a entrada de voz do usuário capturada pelo voicecast.",
  criteria: {
    ditado_texto: "Usuário quer texto colado na janela focada (ditado puro)",
    comando_agente: "Usuário está pedindo uma tarefa para o agente de código executar",
    anotacao_contexto: "Contexto/observação para guardar e associar à sessão, sem ação imediata",
    conversa_social: "Fala dirigida a outra pessoa ou pensamento solto, ignorar",
  },
} as const;

/** Julgamento de sessão (uma chamada, 3 perguntas em paralelo). */
export const Q_RELEVANCIA = {
  type: "score",
  instructions: "Relevância deste transcript como contexto para a próxima tarefa de código do agente.",
  criteria: [
    "Conversa sem relação com código",
    "Contexto geral do projeto",
    "Contém pista útil: sintoma, suspeita ou módulo",
    "Tarefa acionável com critérios claros",
  ],
} as const;

export const Q_PEDIDO = {
  type: "noul",
  instructions:
    "O transcript contém um pedido direto para o agente executar uma tarefa (analisar, editar, rodar, responder)?",
  criteria: {
    true: "Pedido explícito dirigido ao agente/assistente",
    false: "Só conversa/observação, sem pedido",
  },
} as const;

export const Q_RISCO = {
  type: "noul",
  instructions: "A tarefa pedida é somente-leitura e reversível (não muta código, infra nem dados)?",
  criteria: {
    true: "Só ler/diffar/consultar e responder",
    false: "Envolve editar, deployar, deletar ou mutar algo",
  },
} as const;
