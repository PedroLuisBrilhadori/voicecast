/**
 * Ditado (F9) — o modo v2 que absorve o voice-dictation.
 *
 * F9 toggle: captura mic-only SEM janela (zero roubo de foco), no stop envia
 * o wav ao ASR :8701 e cola o texto na janela que estava em foco (clipboard +
 * Ctrl+V sintético). Antes de capturar, segura o F9 do daemon via hold no
 * :8700 (v2 transição); sem daemon, funciona igual (nada para suspender).
 */
import { BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import { asrModelStatus, transcribeAudioFile } from "./asr";
import { logError, logInfo } from "./logging";
import { createDitado, createBar, loadSavedBarBounds } from "./windows";
import { saveDictationSession } from "./library";
import { counter, histogram, withSpan } from "./telemetry";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { IPC, type CaptureEvent } from "../shared/ipc";
import { decidePaste, judgeDictation } from "./jev";
import { annotations } from "./annotations";
import { sessionDirs } from "./storage";

const M_DICTATIONS = counter("voicecast_dictations_total", "ditados por status");
const M_ASR_COLD = counter("voicecast_asr_model_cold_total", "transcrições que esperaram o load do modelo (cold start pós-boot)");
const H_TRANSCRIBE = histogram("voicecast_transcribe_seconds", "duração da transcrição ASR");

function broadcast(e: CaptureEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.event, e);
  }
}

type DictationState = "idle" | "recording" | "transcribing";

let state: DictationState = "idle";
let recorderWin: Electron.BrowserWindow | null = null;
let barWin: Electron.BrowserWindow | null = null;
let blobPromise: Promise<{ b64: string; ext: string }> | null = null;
let ditadoStartedAt = 0;
let ditadoHwnd = 0;
let hotkeyRegistered = false;

export function ditadoState(): DictationState {
  return state;
}

// ── hold no daemon (:8700) ─────────────────────────────────────

function panelUrl(): string {
  return (process.env.VOICE_PANEL_URL || "http://127.0.0.1:8700").replace(/\/$/, "");
}

async function daemonHold(on: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/external/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on, owner: "voicecast" }),
      signal: AbortSignal.timeout(2500),
    });
    if (r.ok) {
      const j = (await r.json()) as { held: boolean };
      logInfo(`daemon hold ${on ? "ON" : "OFF"} (held=${j.held})`);
      return true;
    }
    return false;
  } catch {
    return false; // daemon não existe (v2 completa) — ok
  }
}

async function daemonRecording(): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { state?: string };
    return j.state === "recording" || j.state === "transcribing";
  } catch {
    return false;
  }
}

// ── posse do F9 (heartbeat TTL — se o voicecast morrer, o F9 volta ao daemon) ──

let heartbeatTimer: NodeJS.Timeout | null = null;

/** Reivindica (claim=true) ou devolve (claim=false) a posse do F9 no daemon. */
export async function claimHotkey(claim: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${panelUrl()}/api/external/hotkey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim ? { owner: "voicecast", ttl_s: 60 } : { owner: null }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return false;
    if (claim && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        void fetch(`${panelUrl()}/api/external/hotkey`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: "voicecast", ttl_s: 60 }),
          signal: AbortSignal.timeout(2500),
        }).catch(() => {});
      }, 20_000);
      heartbeatTimer.unref?.();
    }
    if (!claim && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    return true;
  } catch {
    return false;
  }
}

// ── barra de feedback (sem roubar foco) ────────────────────────

function startDitadoBar(): void {
  const { screen } = require("electron") as typeof import("electron");
  barWin = createBar("Ditado", { ditado: true });
  if (!loadSavedBarBounds()) {
    // primeira vez: canto inferior direito; depois, vale onde o usuário arrastou
    const d = screen.getPrimaryDisplay();
    const b = barWin.getBounds();
    barWin.setPosition(d.workArea.x + d.workArea.width - b.width - 18, d.workArea.y + d.workArea.height - b.height - 18);
  }
  barWin.showInactive(); // aparece SEM tomar foco — o Ctrl+V cola onde você estava
}

function closeDitadoBar(): void {
  if (barWin && !barWin.isDestroyed()) barWin.close();
  barWin = null;
}

// ── captura mic-only (renderer oculto, sem foco) ───────────────

async function startCapture(): Promise<{ ok: boolean; error?: string }> {
  const ch = `ditado:blob:${Date.now()}`;
  blobPromise = new Promise((res) => {
    ipcMain.once(ch, (_e, payload: { b64: string; ext: string }) => res(payload));
  });

  const win = createDitado(ch);
  recorderWin = win;
  await new Promise<void>((res) => {
    const wc = win.webContents;
    if (wc.isLoading()) wc.once("did-finish-load", () => res());
    else res();
  });

  const result = (await win.webContents.executeJavaScript(
    `window.vcRecordDictation()`,
    false,
  )) as { ok: boolean; error?: string };
  if (!result?.ok) {
    await stopCaptureWindow();
    return { ok: false, error: result?.error ?? "captura de mic falhou" };
  }
  return { ok: true };
}

async function stopCaptureWindow(): Promise<void> {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;
}

// ── colagem na janela focada (clipboard + Ctrl+V sintético) ────

// ── colagem na janela focada: o CÓDIGO PROVADO do daemon (v2 reusa) ──
// paste_into_focused (win32.py): clipboard + SendInput scan codes (struct
// INPUT cbSize 40) + refoco do HWND capturado no início do ditado + fallback
// unicode. Mesmo comportamento do F9 antigo, literalmente o mesmo código.

function voicePython(): string | null {
  // backend do voicecast primeiro; legado voice-dictation como fallback
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    path.join(local, "voicecast", "asr-backend", ".venv", "Scripts", "python.exe"),
    path.join(local, "voice-dictation", ".venv", "Scripts", "python.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function voiceSrc(): string {
  const local = process.env.LOCALAPPDATA ?? "";
  const backend = path.join(local, "voicecast", "asr-backend", "src");
  return fs.existsSync(backend)
    ? backend
    : path.join(local, "voice-dictation", "src");
}

export function pythonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // VOICE_APP_DIR alinha app_dir() do python à raiz de dados do backend;
  // PYTHONUTF8/PYTHONIOENCODING: Node escreve stdin em UTF-8 mas o Python no
  // Windows decodifica com a codepage da console (cp1252) → texto colado saía
  // mojibake ("Não"→"NÃ£o"). Força UTF-8 nos dois lados do pipe.
  const out: NodeJS.ProcessEnv = { ...env };
  const backendDir = path.join(process.env.LOCALAPPDATA ?? "", "voicecast", "asr-backend");
  if (fs.existsSync(backendDir)) out.VOICE_APP_DIR = backendDir;
  out.PYTHONUTF8 = "1";
  out.PYTHONIOENCODING = "utf-8";
  return out;
}

function spawnHidden(cmd: string, args: string[]) {
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: pythonEnv(),
  });
}

async function captureForegroundHwnd(): Promise<number> {
  const py = voicePython();
  if (!py) return 0;
  return new Promise((res) => {
    const script =
      `import sys; sys.path.insert(0, r"${voiceSrc()}"); ` +
      "from voice.platform import get_backend; print(get_backend().foreground_hwnd())";
    const child = spawnHidden(py, ["-c", script]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => res(0));
    child.on("exit", () => res(parseInt(out.trim(), 10) || 0));
    setTimeout(() => res(0), 5000);
  });
}

/** Cola via paste_into_focused do daemon (stdin = texto, argv1 = hwnd alvo). */
async function pasteViaDaemonCode(text: string, hwnd: number): Promise<boolean> {
  const py = voicePython();
  if (!py) return false;
  return new Promise((res) => {
    const script =
      `import sys; sys.path.insert(0, r"${voiceSrc()}"); ` +
      "from voice.platform import get_backend\n" +
      "text = sys.stdin.read()\n" +
      `used = get_backend().paste_into_focused(text, "auto", ${hwnd})\n` +
      'print("usado:", used, "chars:", len(text))';
    const child = spawnHidden(py, ["-c", script]);
    let err = "";
    child.stdout?.on("data", (d: Buffer) => logInfo(`[paste] ${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.stdin?.end(text);
    child.on("error", () => res(false));
    child.on("exit", (code) => {
      if (code !== 0) logError(`[paste] python saiu ${code}: ${err.slice(-300)}`);
      res(code === 0);
    });
  });
}

async function pasteToFocused(text: string, hwnd: number): Promise<void> {
  // caminho principal: código provado do daemon (refoco do HWND + SendInput)
  if (await pasteViaDaemonCode(text, hwnd)) return;
  // fallback: clipboard + SendKeys (sem janela de console — windowsHide)
  clipboard.writeText(text);
  logInfo("ditado: paste do daemon indisponível — fallback SendKeys");
  const ps = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ],
    { stdio: "ignore", detached: true, windowsHide: true },
  );
  ps.unref();
  logInfo(`ditado: fallback colou ${text.length} chars`);
}

// ── toggle F9 ──────────────────────────────────────────────────

export async function toggleDitado(): Promise<{ ok: boolean; error?: string }> {
  if (state === "idle") {
    // BARRA PRIMEIRO: os checks do daemon (aposentado) custavam até ~4,5s de
    // timeout ANTES da barra nascer — no cold start o F9 parecia morto. Os
    // checks seguem, mas sem bloquear a UX (daemon vivo é caso histórico).
    state = "recording";
    ditadoStartedAt = Date.now();
    void (async () => {
      if (await daemonRecording()) {
        logError("ditado: daemon gravando — abortando captura por segurança");
        state = "idle";
        closeDitadoBar();
        broadcast({ type: "ditado-state", phase: "done" });
        return;
      }
      const held = await daemonHold(true);
      logInfo(`ditado: início (daemon hold ${held ? "aplicado" : "ausente"})`);
    })();
    // HWND da janela em foco AGORA — a colagem refoca ela, mesmo que você
    // mude de janela enquanto o whisper transcreve (comportamento do daemon)
    void captureForegroundHwnd().then((h) => {
      ditadoHwnd = h;
      logInfo(`ditado: alvo da colagem hwnd=${h}`);
    });
    startDitadoBar();
    // AN: overlay de anotação também no ditado (modo somente-transcrição) —
    // anotar dispara print queimado automático (D7); buffer até o dir existir.
    // Painel standalone aberto antes? É adotado (traços pré-ditado entram).
    annotations.beginSession("ditado", ditadoStartedAt);
    broadcast({ type: "ditado-state", phase: "recording" });
    const cap = await startCapture();
    if (!cap.ok) {
      state = "idle";
      closeDitadoBar();
      await daemonHold(false);
      logError("ditado: captura falhou:", cap.error ?? "?");
      return cap;
    }
    return { ok: true };
  }

  if (state === "recording") {
    state = "transcribing";
    const startedAt = ditadoStartedAt;
    // Visibilidade do cold start (pedido do mantenedor): se o modelo do ASR
    // ainda está carregando (primeira uso pós-boot), a barra diz POR QUÊ a
    // transcrição está lenta — com a estimativa que o próprio serviço calibra.
    const model = await asrModelStatus();
    const asrLoading = model ? !model.loaded : false;
    if (asrLoading) M_ASR_COLD?.add(1);
    broadcast({
      type: "ditado-state",
      phase: "transcribing",
      asrLoading,
      expectedLoadS: model?.expectedLoadS,
    });
    const poll = setInterval(async () => {
      if (state !== "transcribing") return clearInterval(poll);
      const m = await asrModelStatus();
      if (m && m.loaded) {
        clearInterval(poll);
        broadcast({ type: "ditado-state", phase: "transcribing", asrLoading: false });
      }
    }, 2500);
    try {
      await withSpan("ditado.stop", { duration_s: +((Date.now() - startedAt) / 1000).toFixed(1) }, async () => {
        recorderWin?.webContents.executeJavaScript("window.vcStopDictation()", true).catch(() => {});
        const payload = await (blobPromise ?? Promise.resolve({ b64: "", ext: "webm" }));
        await stopCaptureWindow();

        // o ASR só engole wav/pcm estáveis → extrai wav do webm via ffmpeg
        const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const tmpDir = mkdtempSync(join(tmpdir(), "vc-ditado-"));
        const src = join(tmpDir, `ditado.${payload.ext}`);
        writeFileSync(src, Buffer.from(payload.b64, "base64"));
      const t0 = Date.now();
      // gancho de teste E2E: VOICECAST_DITADO_FAKE_TEXT pula o ASR (texto fixo)
      const fake = process.env.VOICECAST_DITADO_FAKE_TEXT;
      const t = fake
        ? {
            text: fake,
            language: "pt",
            words: [],
            segments: [],
            transcribedAt: new Date().toISOString(),
            model: "fake",
          }
        : await transcribeAudioFile(src);
      H_TRANSCRIBE?.record((Date.now() - t0) / 1000, { kind: "ditado" });
        rmSync(tmpDir, { recursive: true, force: true });
        const text = t.text.trim();

        // Jev (Etapa 2 do PLANO-JEV-CU): roteia a intenção ANTES de colar —
        // comando pro agente, anotação e conversa não pertencem à janela focada.
        // Fail-soft: sem julgamento (off/sem key/erro) cola como sempre colou.
        const j = text ? await judgeDictation(text) : null;
        const acao = decidePaste(j);

        // v2: ditado com fala vira sessão de áudio na biblioteca; silêncio descarta
        let saved: { dir: string; name: string } | null = null;
        if (text) {
          try {
            saved = saveDictationSession(startedAt, payload.ext, payload.b64, t, j);
          } catch (e) {
            logError("ditado: falhou ao salvar histórico:", e);
          }
        } else {
          logInfo("ditado: nada reconhecido — não salva histórico");
        }
        // anotações do ditado: persiste log + prints queimados na sessão salva
        // (flush do auto-print pendente acontece ANTES de fechar a overlay)
        await annotations.detach(saved ? sessionDirs(saved.dir, saved.name) : null);

        // painel/biblioteca: ditado salvo é mudança de lista (sem isso a lista
        // do picker fica stale — hide/show não remonta o React)
        if (saved) broadcast({ type: "sessions-changed" });

        if (text && acao.paste) {
          await pasteToFocused(text, ditadoHwnd);
        } else if (text) {
          logInfo(`ditado: NÃO colado — rota ${j?.rota} (conf ${j?.confidence?.toFixed(2) ?? "?"})`);
        }
        M_DICTATIONS?.add(1, { status: text ? (acao.paste ? "ok" : `rota:${j?.rota ?? "?"}`) : "vazio" });
        // a barra mostra o desfecho antes de fechar (finally) — quando nada é
        // colado, o usuário precisa saber POR QUÊ
        broadcast({
          type: "ditado-state",
          phase: "done",
          rota: j?.rota,
          conf: j?.confidence,
          colado: text ? acao.paste : undefined,
        });
        if (text) await new Promise((r) => setTimeout(r, acao.paste ? 350 : 2200));
      });
      return { ok: true };
    } catch (e) {
      M_DICTATIONS?.add(1, { status: "erro" });
      logError("ditado: transcrição/colagem falhou:", e);
      // a overlay de anotações (attach no start) não pode ficar presa na tela
      // quando a transcrição falha — mesmo descarte do cancelamento
      if (annotations.active) await annotations.detach();
      return { ok: false, error: String(e) };
    } finally {
      clearInterval(poll);
      await daemonHold(false);
      closeDitadoBar();
      state = "idle";
    }
  }
  return { ok: false, error: "ditado transcrevendo — aguarde" };
}

export function registerDitadoHotkey(): void {
  if (hotkeyRegistered) return;
  globalShortcut.register("F9", () => {
    void toggleDitado();
  });
  hotkeyRegistered = true;
  logInfo("ditado: F9 registrado no voicecast");
}
