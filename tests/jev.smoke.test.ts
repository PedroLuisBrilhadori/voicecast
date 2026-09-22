/**
 * Smoke da API real (TypeSafe/Jev) — NÃO roda no CI. Rodar sob pedido:
 *
 *   VOICECAST_JEV_SMOKE=1 TYPESAFE_API_KEY=<key> pnpm vitest run tests/jev.smoke.test.ts
 *
 * Valida que as perguntas de src/main/jev-questions.ts continuam produzindo
 * decisões coerentes com o modelo corrente (se o texto mudar sem revalidar,
 * é aqui que aparece).
 */
import { describe, expect, it } from "vitest";
import { judgeDictation, judgeSession } from "../src/main/jev";

const SMOKE = process.env.VOICECAST_JEV_SMOKE === "1";

describe.skipIf(!SMOKE)("jev smoke (API real)", () => {
  it(
    "F9: comando roteia como comando_agente com confiança alta",
    async () => {
      const j = await judgeDictation("abre um pull request do branch atual e pede revisão pro time");
      expect(j).not.toBeNull();
      expect(j!.rota).toBe("comando_agente");
      expect(j!.confidence).toBeGreaterThan(0.7);
    },
    20_000,
  );

  it(
    "F9: ditado puro roteia como ditado_texto",
    async () => {
      const j = await judgeDictation("querido cliente segue em anexo o relatório da semana att pedro");
      expect(j?.rota).toBe("ditado_texto");
    },
    20_000,
  );

  it(
    "sessão: relevância alta + tarefa somente-leitura",
    async () => {
      const s = await judgeSession(
        "[00:12] cara, olha esse dashboard do grafana, o painel de latência tá com pico de 3 segundos de p99 desde ontem " +
          "[00:48] quero que você abre o repo, olha o diff do deploy de ontem e me diz se mudou alguma query sem índice " +
          "[01:10] não mexe em nada não, só analisa e me responde",
        { mode: "tela+mic" },
      );
      expect(s).not.toBeNull();
      expect(s!.relevancia).toBeGreaterThan(1.5);
      expect(s!.pedido).toBeGreaterThan(0.5);
      expect(s!.risco).toBeGreaterThan(0.5); // somente-leitura = noul alto
    },
    20_000,
  );
});
