# Relatório — ASR hosted: voicecast hospeda o backend de transcrição (2026-09-22)

## Contexto

A sessão `2026-09-22/0933-7329b0fb` (teste de gravação) terminou com
`transcriptStatus: "sem-asr"`: o voicecast era apenas cliente HTTP do serviço
compartilhado `:8701` do voice-dictation, e esse serviço foi morto às ~09:33
na sessão de diagnóstico dos travamentos (aposentadoria do voice-dictation).
A VISAO-V2 prometia "voicecast absorve o voice-dictation", mas a absorção
nunca alcançou o backend de transcrição — ficou só na UI/captura/F9/biblioteca.

## O que mudou

1. **`asr-backend/`** — subset do python do `voice` vendorizado no repo:
   `asr_service.py`, `telemetry.py`, `platform/{__init__,common,win32,linux}.py`.
   Única divergência vs server-docs: `app_dir()` respeita `VOICE_APP_DIR`
   (o host define a raiz de dados). Daemon/painel/dataset não vieram
   (aposentados).
2. **`src/main/asr-host.ts` + `src/shared/asr-host-logic.ts`** — supervisor no
   processo main: probe de `/health` antes de qualquer spawn (nunca duplica um
   serviço que já responde — externo é adotado), respawn com backoff
   5s→10s→20s→40s→60s, reset após 60s estável, logs do filho em
   `logs/asr-backend.log`. Chamado no `whenReady`; derruba o filho no
   `will-quit`. Fail-soft: qualquer erro só loga.
3. **`scripts/setup-asr-backend.ps1`** — instala em
   `%LOCALAPPDATA%\voicecast\asr-backend` o src sincronizado + venv próprio
   (uv, python 3.12, faster-whisper + CUDA wheels) + sitecustomize de DLLs
   CUDA. Idempotente (hash de deps). Modelos: cache HF do usuário, sem
   re-download. `-Check` só reporta estado.
4. **`src/main/ditado.ts`** — paste (`voice.platform`) agora resolve o
   python/src do backend do voicecast primeiro, com fallback legado
   (voice-dictation) durante a transição; spawns levam `VOICE_APP_DIR`.

Decisões: OTel do serviço fica **off** (`OTEL_ENABLED=0` no spawn — o venv
próprio não instala deps OTel; best-effort por design no telemetry.py). A
porta continua `8701` e o cliente (`asr.ts`, failover de URLs) não mudou —
migração de acesso zero. Kill-switch `VOICECAST_ASR_HOST=0`; endpoints
externos via `VOICECAST_ASR_URLS`/`VOICE_ASR_URLS` desativam o hosting.

## Validação

- WSL: typecheck + vitest (45 ✓, incl. 6 novos de `asr-host-logic`) + build.
- Windows (real, 2026-09-22 ~10:07): `setup-asr-backend.ps1` — venv próprio +
  36 pacotes (CUDA wheels incl.), src sincronizado, sitecustomize OK. Smoke
  `--transcribe=2026-09-22/0933-7329b0fb` (a sessão que motivou tudo):
  `exit=0`, `transcript.json` gerado (121 palavras, pt, large-v3-turbo),
  `meta.json.transcriptStatus: done`, julgamento Jev da sessão ok
  (rota comando_agente). App relançado: backend hospedado pelo app, health
  `{"status":"ok","device":"cuda"}`, stdout do filho em `logs/asr-backend.log`.

### Lições do caminho

1. **`.ps1` precisa ser 100% ASCII** (PowerShell 5.1 lê sem BOM como ANSI —
   acentos quebram o parse; mesma razão dos comentários "c-pia" do
   sync-to-host.ps1).
2. **Corrida na cold start**: `--transcribe` chamava `asrHealth()` ~300ms
   após o `whenReady`, antes de o python abrir a porta (~13s) → marcava
   `sem-asr` e saía. Correção: `asrHealth({ waitMs })` com retry de 1s e a
   transcrição de sessão espera 30s (a porta abre cedo; o load do modelo
   continua em background e o `/v1/transcribe` espera por ele no servidor).
3. **Ciclo de vida do filho**: com `app.exit()` (caminho do `--transcribe`),
   `will-quit` NÃO dispara e o `stopAsrHost` não roda — mas o filho morre com
   o electron mesmo assim (job object herdado), sem órfãos. Verificado:
   relançamento seguinte fez spawn limpo.
4. O `python.exe` do venv uv é um trampolim que re-executa o CPython
   gerenciado — **2 PIDs é 1 serviço** (não confundir com duplicação, como
   aconteceu no diagnóstico dos travamentos).

## Pendências

- Colagem ainda spawna python do backend (código provado do win32.py). Port
  para FFI nativo (koffi) segue como evolução — era item da VISAO-V2, mas
  reescrever o SendInput canônico reabre o bug do struct INPUT; mantido o
  python até haver motivo real.
- Mistério do launcher do voice-dictation no logon (sessão
  sess_0fb5aee6): algo sobe o supervisor antigo no boot — se voltar, o
  asr-host adota o serviço externo (sem duplicar), mas a limpeza definitiva
  (deletar `%LOCALAPPDATA%\voice-dictation`) depende de encontrar o launcher.
- Hosting no Linux (note) não implementado — lá o ASR remoto
  (`asr-remoto-pchome.md`) segue via `VOICECAST_ASR_URLS`, que já desliga o
  hosting.
