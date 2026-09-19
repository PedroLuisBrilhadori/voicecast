# voicecast — Relatório F0 (de-risk de runtime e impedimentos)

Data: 2026-09-19 · Máquina: pchome-win (Win 11 26200, RTX 3050, 32GB, 1 monitor físico + 1 virtual, **scaleFactor 1.53**)

## Resumo

| Item | Veredito |
|---|---|
| **PoC Electron** | ✅ **PASSOU o roteiro completo** — ver números abaixo |
| **PoC WebView2 (Tauri)** | ❌ `getDisplayMedia` → **NotAllowedError "Permission denied"**, sem seletor (evidência: screenshot do mantenedor; interação por clique também sem sucesso) |
| Setup Tauri no Windows | ⚠️ exige instalar rustup + VS Build Tools (~GBs) — não instalado hoje |
| Coexistência mic (daemon F9 + app) | ✅ OK (WASAPI shared) |
| Handoff ZCode (Read de MP4) | ✅ OK com vídeos < 30MB |
| ASR word-timestamps (:8701) | ✅ já retorna `words {w,start,end,p}` |
| Jev | ✅ confirmado: só gate (`noul`), sem streaming/visão/execução |

## Números do PoC Electron (Electron 44.4.3 · Chromium 152 · Node 24)

| Métrica | Valor |
|---|---|
| Fontes enumeradas | 2 telas + 11 janelas (nomes reais: ZCode, Obsidian, VSCode, WhatsApp…) c/ thumbnails |
| Gravação tela+mic 12s | MP4 H.264 1920x1080 ~25fps + AAC · **2.4MB** · áudio audível (max −38.5dB) |
| Gravação janela+mic 8s | 1.0MB · áudio max −19.8dB |
| mimeType escolhido | `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` (MP4 nativo, como previsto) |
| Latência início do stream | 0.9–1.5s |
| Atalhos globais Ctrl+F9 / Ctrl+Shift+F9 | ✅ registrados |
| Overlay transparente fullscreen + retângulo | ✅ funciona (proof: `overlay-proof.png`); coords CSS × físicas (DPI 1.53) |
| RAM (soma processos) | **254MB idle → 566MB gravando** |
| Tamanho dev (node_modules) | 382MB (empacotado típico ~200–250MB) |
| Quirks | track 1921×1081 (+1px, arredondar crop); rVFC não conta frames em renderer oculto (artefato de medição, não do arquivo) |

## Validações cruzadas

- **ZCode Read vídeo**: leu com sucesso (a) MP4 sintético 5.8MB/30s e (b) **a gravação real do PoC (2.4MB)** — loop gravação→agente completo.
- **Limite 30MB do Read**: 60s sintético a CRF23 = 43.8MB (estoura); tela real ≈ 7–12MB/min → **handoff deve apontar para prints + clipes + transcript**, não para a sessão crua longa.
- **Coexistência mic**: `sounddevice` (mesmo stack do daemon F9) gravou simultaneamente ao Electron — peak 1249, max −28.4dB. Nada de exclusividade.
- **ffmpeg**: WSL 8.0 analisa/processa tudo via /mnt/c; produto resolve binário igual ao voice (env > PATH > imageio-ffmpeg).

## Impedimentos e contra-medidas (nenhum bloqueante)

1. **Read 30MB** → artefatos de handoff: prints (PNG), clipes curtos (≤1–2min), transcript, e eventual "contact sheet" da sessão num PNG único.
2. **fMP4 sem duração** → remux `-c copy -movflags +faststart` no stop (pipeline M1).
3. **DPI 1.53 real** → matemática de região/crop em px físicos desde o dia 1 (testado no overlay).
4. **Mimosa guard** bloqueou código PoC com `open()` de path dinâmico → no produto, paths literais/sanitizados (babado documentado pro M0).

## Decisão de runtime — FINAL: **Electron**

- **WebView2 (motor do Tauri no Windows) negou `getDisplayMedia`** no runtime 153 da máquina: `NotAllowedError — Permission denied`, sem seletor; clique do usuário também sem sucesso. É o comportamento do risco #5314: captura no WebView2 não vem de graça — exigiria captura em Rust (crate windows-capture) ou handler de `ScreenCaptureStarting` no host.
- **Electron passou 100% do roteiro**: captura de janela/tela com thumbs, MP4 avc1+AAC nativo, overlay transparente (com DPI 1.53 real), atalhos globais, latência sub-1.5s, mic coexistindo com o daemon F9.
- Custos aceitos e conhecidos: RAM ~254MB idle / ~566MB gravando; ~250MB instalado; runtime novo no workspace.
- Desempate prático: Tauri ainda carregaria instalar rustup+VS Build Tools (~GBs) **antes** de escrever a primeira linha do produto.

## Pendências

- [x] Resultado do PoC WebView2 — ❌ negado (screenshot arquivado na sessão de 2026-09-19)
- [ ] Nota de aprendizado no vault (skill capturar-nota)
- [ ] M0: criar repo `voicecast` e levar este relatório para `docs/`
