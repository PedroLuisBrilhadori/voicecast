# U1 — Build do CLI ZCode a partir do código aberto · pronto (exploratório)

## Objetivo
Produzir um binário `zcode` CLI **do repo open source** (github.com/zai-org/zcode,
branch main) e provar o goal headless de verdade
(`zcode -p "Responda somente: ok" --surface terminal`). Isso destrava o C2 do
cockpit: o CLI instalado (0.16.9) não consome `defaultModelSelection` no `-p`,
mas o main consome (drift de versão — ver RESULTADOS.md do probe, "Adendo 2").

## Contexto obrigatório (ler antes)
- `/home/pedro/programing/projetos/voicecast/scripts/probes/2026-09-27-acp/RESULTADOS.md`
  (seções "Adendo do roundtrip" e "Adendo 2 — código aberto") — TODO o contexto
  técnico do desbloqueio
- `/tmp/zcode-src/` — clone shallow já existente (se não existir, clonar de novo:
  `git clone --depth 1 https://github.com/zai-org/zcode.git /tmp/zcode-src`)
- `/tmp/zcode-src/README.md` / `mise.toml` / `package.json` — como buildar
  (workspace pnpm; CLI em `apps/zcode-cli`)

## Escopo
**Fazer:**
1. Buildar o CLI no clone (`/tmp/zcode-src`) seguindo a documentação do repo
   (esperado: instalar deps com pnpm — COREPACK/pnpm do sistema — e buildar
   `apps/zcode-cli`; descobrir o comando exato e o artefato gerado).
2. Rodar o goal headless com o binário novo, usando os mesmos envs que
   validamos: `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/tmp/zcode-builtin-provider.json`
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=$HOME/.zcode/v2/provider_config.json`
   (o pessoal JÁ tem `defaultModelSelection` gravado).
3. Se o goal responder: copiar o binário para `/tmp/zcode-cli-build/zcode` e
   documentar em `/tmp/zcode-cli-build/BUILD.md` o comando exato de build.
4. Se o build ou o goal falharem: documentar o erro exato e até onde foi em
   `/tmp/zcode-cli-build/BUILD.md` e PARAR (não improvisar patches no clone).

**Não tocar:** NADA dentro de `~/.zcode` (config/credentials do usuário),
o repo voicecast, installs globais, PATH. Tudo confinado a /tmp.

## Aceite verificável
- `/tmp/zcode-cli-build/BUILD.md` existe, com comando de build reproduzível e
  o resultado do goal (stdout real ou erro exato).
- Melhor caso: goal responde "ok" (exit 0) — C2 desbloqueado de verdade.

## Riscos e gotchas
- Build pode exigir versão específica de node/pnpm — checar mise.toml; se
  incompatível com o ambiente e não houver caminho rápido, documentar e parar.
- O clone é shallow (depth 1) — ok para build.
- Limite de tempo razoável: se passar de ~20 min de tentativas, documentar e parar.

## Entrega
Nenhum commit (trabalho em /tmp). Preencher Resultado abaixo.

## Resultado (preenche o piloto)
- (pendente)
