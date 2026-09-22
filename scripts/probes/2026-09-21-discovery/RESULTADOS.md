# Discovery 2026-09-21 — Jev + computer use + ZCode (probes e achados)

Sessão de discovery (não fechada). Contexto: integrar Jev (TypeSafe) de forma
consistente no voicecast, portar a abordagem de computer use para Windows e
plugar tudo no ZCode como harness principal, em nível de máquina (pchome-win,
note, macmini, s10deck). Recupera e continua as decisões da sessão
`sess_bc340fad-8535-4e68-a2c6-e71012a30136` (Migração do Opencode para Zcode),
cujo plano foi escrito mas não executado (ExitPlanMode negado).

## Probes executados (todos PASSARAM)

### 1. Jev como camada de decisão do voicecast — `jev-systemone-voicecast.mjs`

Uma chamada `POST /v1/systemone` com 4 perguntas (choice + 2×noul + score)
sobre transcript real de sessão voz+tela:

| Pergunta | Resultado | Confiança |
|---|---|---|
| `rota_f9` (choice: ditado/comando_agente/anotação/conversa) | **comando_agente** | 0.98 |
| `pedido_de_acao` (noul) | 0.98 | — |
| `risco_da_acao` (noul: só-leitura?) | 0.97 | — |
| `relevancia_contexto` (score 0–3) | **2.92** (→ nível 3) | 0.92 |

**741ms · 815 input + 120 output tokens · model jev-1.13.0.** Padrão validado:
F9/sessão → 1 chamada → rota + gate de risco + score de relevância juntos.

⚠️ **Drift achado no cliente local**: `scripts/lib/jev-judge.ts` (workspace)
declara `type: "boolean"` — a API **só aceita `noul|choice|score`** (400
`api_usage_error`), noul.criteria é objeto `{true,false}`, choice.criteria é
map opção→descrição, score.criteria é array ordenado. O local também não tem
`choice`. SDK oficial: `@typesafe-ai/sdk@0.6.0` (npm, TS) / `typesafe-sdk`
(Python, 0.0.0). Skill oficial de agentes: `npx skills add typesafe-ai/skills`.

### 2. OCR nativo Windows (WinRT) — `ocr-winrt.ps1`

`Windows.Media.Ocr` sobre `CopyFromScreen` da tela primária, via interop WSL:

- captura 241ms (1920×1080) · **OCR 444ms** · language pack pt-BR já presente
- leu texto real da tela (janela do ZCode, inclusive título desta tarefa)
- zero dependências — equivalente do Apple Vision no port Windows
- quirk: "Ctrl+N" → "CtrI+N" (I/l) — OCR complementa UIA, não substitui

### 3. Árvore UIA da janela em primeiro plano — `uia-tree.ps1`

`System.Windows.Automation` sobre a janela do ZCode (Electron/Chromium):

- **381 nós ControlView em 140ms** · 345 com nome · **72 com InvokePattern**
- amostra: Command palette, New task, botões `[Invoke]`, lista de tarefas
- ⇒ Electron expõe UIA sem flags extras; InvokePattern = equivalente do AXPress
- ação restante: SendInput (precedente `voice/platform/win32.py`, port via
  koffi previsto na VISAO-V2)

Custo estimado por passo do loop CU (percepção ~0.6s + Jev ~0.7s):
≈ **1.5s e <$0.0003** — na bola do projeto macOS (~$0.0002/passo).

## Mapa do discovery (confirmado por fontes/probes)

- **Jev** = só decisão (não há computer use na TypeSafe; API não aceita imagem).
  O projeto viral do Twitter = **`awlevin/typesafe-computer-use`** (MIT,
  macOS): OCR+AX em texto estruturado → Jev Choice decide → AXPress/click;
  único adapter de plataforma é `macos.py`; não há port Windows.
- **Port Windows não é "portar do zero"**: percepção = desktopCapturer (já no
  voicecast) + WinRT OCR (probe 2) + UIA (probe 3); ação = InvokePattern +
  SendInput. Voicecast hospeda o loop (decisão do mantenedor, sess_bc340fad).
- **ZCode**: OSS Apache-2.0 (github.com/zai-org/ZCode; desktop Electron com
  build win, server com remote WSL — topologia atual aqui é
  `desktop-attached-remote`). Plugin oficial **`computer-use` (0.6.3)** no
  marketplace declara target `mac|windows|linux` — **instalado no cache mas
  NÃO habilitado** nesta máquina (installed_plugins.json só tem obsidian,
  video-agent-kit, mimosa). Duas superfícies de CU coexistem: CUA do ZCode
  (agente-iniciado, GLM) vs loop voicecast+Jev (voz-iniciado, determinístico
  barato) — complementares; gate Jev pode envolver as duas.
- **Fabric multi-máquina**: `mcp-peer.mjs` v1.3.0 (server-docs, stdio+SSH,
  telemetria JSONL→OTel, INFRA_MCP_LEVEL ro|rw) já roda como MCP `infra`/
  `pchome` no zcode.json. É o multiplicador: contexto voicecast + decisões
  Jev + CU alcançáveis de note/macmini (+s10deck futuro).

## Fronts abertos (próximos spikes)

1. Instalar plugin `computer-use` no ZCode Desktop (UI do marketplace) e provar
   `computer.target` na topologia desktop-attached-remote (Windows host vs WSLg).
2. Injeção voz→ZCode: CLI headless do OSS (`apps/zcode-cli`, flag de print/exec
   não verificada) vs hook UserPromptSubmit vs skill/slash. Sem CLI Windows
   instalado hoje (só ZCode.exe Desktop).
3. Consolidar cliente Jev (marco FJ reescrito): `jev-judge` canônico com
   choice + criteria corretos, adoção do SDK oficial, unificar guardrail/qa.
4. MCP do voicecast (sessions_search/transcript/clip) + transporte via padrão
   mcp-peer p/ agentes das outras máquinas.
5. s10deck como nó do fabric (peer SSH/Termux?).

## Como re-rodar

```bash
# Jev (precisa TYPESAFE_API_KEY no .env da raiz do workspace)
node voicecast/scripts/probes/2026-09-21-discovery/jev-systemone-voicecast.mjs
# OCR + UIA (host Windows, a partir do WSL)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File voicecast/scripts/probes/2026-09-21-discovery/ocr-winrt.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File voicecast/scripts/probes/2026-09-21-discovery/uia-tree.ps1
```
