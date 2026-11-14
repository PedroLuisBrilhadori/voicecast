/**
 * Smoke of the real API (TypeSafe/Jev) — does NOT run on CI. Run on demand:
 *
 *   VOICECAST_JEV_SMOKE=1 TYPESAFE_API_KEY=<key> pnpm vitest run tests/jev.smoke.test.ts
 *
 * Validates that the questions in src/main/jev-questions.ts keep producing
 * decisions consistent with the current model (if the text changes without
 * revalidation, it shows up here).
 */
import { describe, expect, it } from "vitest";
import { judgeDictation, judgeSession } from "../src/main/jev";

const SMOKE = process.env.VOICECAST_JEV_SMOKE === "1";

describe.skipIf(!SMOKE)("jev smoke (real API)", () => {
  it(
    "F9: command routes as comando_agente with high confidence",
    async () => {
      const j = await judgeDictation("abre um pull request do branch atual e pede revisão pro time");
      expect(j).not.toBeNull();
      expect(j!.rota).toBe("comando_agente");
      expect(j!.confidence).toBeGreaterThan(0.7);
    },
    20_000,
  );

  it(
    "F9: pure dictation routes as ditado_texto",
    async () => {
      const j = await judgeDictation("querido cliente segue em anexo o relatório da semana att pedro");
      expect(j?.rota).toBe("ditado_texto");
    },
    20_000,
  );

  it(
    "session: high relevance + read-only task",
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
      expect(s!.risco).toBeGreaterThan(0.5); // read-only = high noul
    },
    20_000,
  );
});
