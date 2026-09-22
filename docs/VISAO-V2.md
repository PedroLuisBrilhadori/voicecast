# voicecast — Visão v2 (decisão do mantenedor, 2026-09-19)

## Decisão

O **voicecast é a v2 do voice-dictation**. Não são produtos irmãos independentes:
o voicecast **absorve o ditado** e os dois sistemas convergem. Decidido pelo
mantenedor ao ver os dois apps capturando o mesmo microfone em paralelo sem se
conhecerem.

### O que cada um vira

| Hoje (voice-dictation) | Na v2 (voicecast) |
|---|---|
| Daemon Python + painel :8700 | **Aposentado gradualmente** — o app Electron assume a UI e a captura |
| F9 ditado → ASR → cola na janela focada | **F9 vira atalho do voicecast**: ditado é um modo de captura (mic-only, sem vídeo) — mesma barra, mesma biblioteca, colagem na janela focada mantida |
| ASR :8701 (faster-whisper local) | **Hosted pelo voicecast** (desde 2026-09-22): o app spawna e supervisiona o serviço python vendorizado (`asr-backend/`) — o acesso continua via HTTP `:8701`, mas o runtime agora é nosso. Aposentado o serviço compartilhado do voice-dictation. |
| Dataset de treino (`datasets/raw` + `transcriptions`, correções no painel, export JSONL) | **Evolução natural**: o voicecast passa a ler/escrever o mesmo layout de dataset (mesmo schema de `words`/`corrections`) — correções e histórico de treino continuam valendo; ditados e sessões convergem num único corpo de dados |

### Por quê

- Hoje a mesma frase pode virar dois artefatos em dois projetos (dataset do ditado
  + faixa de áudio do mp4 da sessão) sem ligação entre si.
- Duas UIs para a mesma voz (barra :8700 vs barra voicecast) divide a experiência.
- O voicecast já entrega a barra always-on-top, o pipeline de mídia e o storage
  que o ditado precisa — duplicar em Python não faz sentido.

## Transição (enquanto o daemon existir)

1. **Coordenação de captura via API local**: voicecast sinaliza ao daemon
   (endpoint no :8700) "sessão ativa" → daemon suspende o F9 (painel mostra
   "voicecast gravando"); se o ditado estiver capturando, o voicecast avisa na UI.
   Fim da captura dupla acidental. (barato, faz parte do M2)
2. **Ditado no voicecast** (marco próprio, após M2): F9 global → captura mic-only
   no Electron → detecção de fim de fala → `POST :8701/v1/transcribe` → texto no
   clipboard + `Ctrl+V` sintético na janela focada (portar o SendInput do
   `voice/platform/win32.py` — struct INPUT com union, cbSize 40 — para FFI/koffi).
3. **Integração de dataset**: voicecast escreve ditados no layout do voice
   (mesmos JSONs, mesmos `words`), lê o histórico existente; export JSONL
   (`voice-export`) continua apontando para o mesmo corpus. Painel de correção
   do voice :8700 permanece até o voicecast ter tela equivalente.
4. **Aposentadoria do daemon**: só quando F9 no voicecast for paridade completa
   (hotkey global, colagem confiável nos 2 SOs, dataset intacto, runbooks atualizados).

## Backlog relacionado (issues no GitHub)

- Áudio do sistema (loopback WASAPI) como faixa opcional da sessão — hoje só mic.
- Tela de correção/rotulação de ditados dentro do voicecast (substitui o painel :8700).
