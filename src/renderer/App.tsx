import { useEffect, useState } from "react";
import type { Bootstrap } from "../shared/ipc";

declare global {
  interface Window {
    voicecast: import("../shared/ipc").VoicecastBridge;
  }
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [pong, setPong] = useState<string | null>(null);

  useEffect(() => {
    window.voicecast.getBootstrap().then(setBoot).catch(console.error);
  }, []);

  const testPing = () => {
    const nonce = Date.now();
    window.voicecast
      .ping({ nonce })
      .then((res) => setPong(res.nonce === nonce ? "ok" : "nonce divergente"))
      .catch((e) => setPong(String(e)));
  };

  return (
    <div className="app">
      <header>
        <h1>
          voicecast <span className="tag">{boot ? `v${boot.version}` : "…"}</span>
        </h1>
        <p className="sub">
          Sessões de contexto: voz + tela → transcrição local → trechos, prints e
          contexto para o agente.
        </p>
      </header>

      <main>
        <div className="modes">
          <button className="mode" disabled title="Disponível no M1">
            <span className="mode-icon">🖥</span>
            <span className="mode-title">Tela cheia</span>
            <span className="mode-hint">{boot?.shortcuts.recordFullscreen ?? "Ctrl+Shift+F9"}</span>
          </button>
          <button className="mode" disabled title="Disponível no M1">
            <span className="mode-icon">🪟</span>
            <span className="mode-title">Janela específica</span>
            <span className="mode-hint">escolha entre as janelas abertas</span>
          </button>
          <button className="mode" disabled title="Disponível no M1">
            <span className="mode-icon">▭</span>
            <span className="mode-title">Região</span>
            <span className="mode-hint">selecione com um retângulo</span>
          </button>
        </div>

        <section className="meta">
          <h2>Fundação (M0)</h2>
          <ul>
            <li>
              Atalho global <kbd>{boot?.shortcuts.togglePanel ?? "Ctrl+F9"}</kbd> abre/oculta
              este painel em qualquer app.
            </li>
            <li>Captura, gravação e editor chegam nos próximos marcos (M1/M2).</li>
            <li>
              IPC: <button onClick={testPing}>testar ping</button>{" "}
              {pong && <code className={pong === "ok" ? "ok" : "err"}>{pong}</code>}
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
