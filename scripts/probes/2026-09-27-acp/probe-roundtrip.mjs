#!/usr/bin/env node
/**
 * probe-roundtrip.mjs — C2 de-risk: roundtrip REAL contra o zcode-server
 * (initialize → createSession → sendText → eventos de turno).
 *
 * Protocolo decodificado no probe-acp (RESULTADOS.md): handshake ndjson
 * (zcode-hello/ack) + framing binário VS Code (13B) + payload vscode-rpc
 * (2 valores serializados: header array + body). Este arquivo carrega uma
 * cópia mínima do serializer — a fonte da verdade testável é
 * src/main/agent/protocol.ts (+ tests/agent-protocol.test.ts).
 *
 * Uso: node probe-roundtrip.mjs [--cwd DIR] [--goal "texto"]
 * Exit: 0 = turn.completed observado · 2 = evidência coletada, sem turn.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const logStream = fs.createWriteStream(path.join(here, "roundtrip-log.jsonl"));
const rec = (dir, data) => {
  logStream.write(JSON.stringify({ dir, at: new Date().toISOString(), data }) + "\n");
  const s = typeof data === "string" ? data : JSON.stringify(data);
  if (s && s.length < 400) console.log(`${dir === "in" ? "◀" : "▶"} ${s}`);
};

// ── cópia mínima do serializer (espelho de src/main/agent/protocol.ts) ──
const TAG = { UNDEFINED: 0, STRING: 1, BUFFER: 2, VSBUFFER: 3, ARRAY: 4, OBJECT: 5, INT: 6 };
const vql = (n) => {
  const out = [];
  do { let b = n & 127; n >>>= 7; if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
};
const one = (t) => Buffer.from([t]);
function ser(value, chunks) {
  if (value === undefined) { chunks.push(one(TAG.UNDEFINED)); return; }
  if (typeof value === "string") { const b = Buffer.from(value, "utf8"); chunks.push(one(TAG.STRING), vql(b.length), b); return; }
  if (value instanceof Uint8Array) { chunks.push(one(TAG.BUFFER), vql(value.byteLength), Buffer.from(value)); return; }
  if (Array.isArray(value)) { chunks.push(one(TAG.ARRAY), vql(value.length)); for (const el of value) ser(el, chunks); return; }
  if (typeof value === "number" && (value | 0) === value) { chunks.push(one(TAG.INT), vql(value)); return; }
  const b = Buffer.from(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { __zcode_rpc_nested_uint8array_v1: true, base64: Buffer.from(v).toString("base64") } : v)), "utf8");
  chunks.push(one(TAG.OBJECT), vql(b.length), b);
}
const serializeRpc = (...values) => { const chunks = []; for (const v of values) ser(v, chunks); return Buffer.concat(chunks); };
function deser(buf, cur) {
  const tag = buf[cur.o++];
  if (tag === TAG.UNDEFINED) return undefined;
  if (tag === TAG.STRING) { const n = readVql(buf, cur); const v = buf.subarray(cur.o, cur.o + n).toString("utf8"); cur.o += n; return v; }
  if (tag === TAG.BUFFER || tag === TAG.VSBUFFER) { const n = readVql(buf, cur); const v = buf.subarray(cur.o, cur.o + n); cur.o += n; return v; }
  if (tag === TAG.ARRAY) { const n = readVql(buf, cur); const a = []; for (let i = 0; i < n; i++) a.push(deser(buf, cur)); return a; }
  if (tag === TAG.INT) return readVql(buf, cur);
  if (tag === TAG.OBJECT) { const n = readVql(buf, cur); const v = JSON.parse(buf.subarray(cur.o, cur.o + n).toString("utf8")); cur.o += n; return v; }
  throw new Error(`tag rpc desconhecida: ${tag} @${cur.o - 1}`);
}
function readVql(buf, cur) {
  let value = 0, n = 0;
  for (; ; n += 7) { const b = buf[cur.o++]; value |= (b & 127) << n; if (!(b & 128)) return value; }
}
const FRAME_HDR = 13;
const writeFrame = (payload, type = 1) => {
  const f = Buffer.alloc(FRAME_HDR + payload.byteLength);
  f.writeUInt8(type, 0); f.writeUInt32BE(0, 1); f.writeUInt32BE(0, 5); f.writeUInt32BE(payload.byteLength, 9);
  payload.copy(f, FRAME_HDR);
  return f;
};
const rpcFrame = (header, body) => writeFrame(serializeRpc(header, body));
// body = ARRAY de args posicionais (fromService faz target.apply(handler, args))
const requestFrame = (id, channel, method, arg) => rpcFrame([100, id, channel, method], [arg]);
const listenFrame = (id, channel, event, arg) => rpcFrame([102, id, channel, event], [arg]);

// ── sessão com o server ────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const CWD = flag("--cwd", path.join(os.homedir(), "programing/projetos"));
const GOAL = flag("--goal", "Responda somente: ok");
const NODE = process.env.ZCODE_SERVER_NODE || path.join(os.homedir(), ".zcode/server/node");
const CJS = process.env.ZCODE_SERVER_CJS || path.join(os.homedir(), ".zcode/server/zcode-server.cjs");

const child = spawn(NODE, [CJS], { stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map(); // id → {resolve}
const listeners = new Map(); // id listen → (header, body) => void
let sawTurn = false;
let frameBuf = Buffer.alloc(0);
let helloDone = false;
let helloBuf = Buffer.alloc(0);

const send = (buf) => { rec("out", buf.toString("hex").slice(0, 160)); child.stdin.write(buf); };
const request = (channel, method, arg, timeoutMs = 30000) => new Promise((resolve) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); resolve({ TIMEOUT: `${method} ${timeoutMs}ms` }); }, timeoutMs);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
  send(requestFrame(id, channel, method, arg));
  return id;
});
const listen = (channel, event, arg) => new Promise((resolve) => {
  const id = nextId++;
  listeners.set(id, resolve);
  send(listenFrame(id, channel, event, arg));
  return id;
});

const onFrames = () => {
  for (;;) {
    if (frameBuf.length < FRAME_HDR) return;
    const len = frameBuf.readUInt32BE(9);
    if (frameBuf.length < FRAME_HDR + len) return;
    const body = frameBuf.subarray(FRAME_HDR, FRAME_HDR + len);
    frameBuf = frameBuf.subarray(FRAME_HDR + len);
    const cur = { o: 0 };
    let header, payload;
    try { header = deser(body, cur); payload = deser(body, cur); }
    catch (e) { rec("err", `deser falhou: ${e.message}`); continue; }
    const [type, id, channel, name] = header;
    if (type === 100) rec("in", { srvRequest: name, id, channel, args: payload });
    if (type === 201 || type === 202 || type === 203 || type === 204) rec("in", { type, id, data: payload });
    if (type === 204 && listeners.has(id)) listeners.get(id)(payload);
    if (pending.has(id)) { const p = pending.get(id); pending.delete(id); p.resolve({ type, data: payload }); }
    // direção reversa: o server age como cliente — responde requests dele
    if (type === 100) {
      if (name === "session/requestRuntimePreferences") {
        const result = {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: "preflight-v1",
        };
        send(rpcFrame([201, id], result));
        rec("out", `respondido requestRuntimePreferences id=${id}`);
      } else {
        send(rpcFrame([202, id], { message: `voicecast-probe: método reverso não suportado: ${name}` }));
        rec("out", `negado request reverso ${name} id=${id}`);
      }
    }
    const str = JSON.stringify(payload) ?? "";
    if (/turn\.(completed|failed)/.test(str)) sawTurn = true;
  }
};
child.stdout.on("data", (chunk) => {
  if (!helloDone) {
    helloBuf = Buffer.concat([helloBuf, chunk]);
    const nl = helloBuf.indexOf("\n");
    if (nl < 0) return;
    const line = helloBuf.subarray(0, nl).toString("utf8");
    frameBuf = Buffer.from(helloBuf.subarray(nl + 1));
    helloDone = true;
    rec("in", line);
    // ack é LINHA ndjson crua (waitForAck lê até \n) — só depois vira binário
    child.stdin.write(JSON.stringify({ type: "zcode-hello-ack", version: "1.0.0-voicecast", clientId: "voicecast-roundtrip" }) + "\n");
    rec("out", "zcode-hello-ack (ndjson)");
    onFrames();
    return;
  }
  frameBuf = Buffer.concat([frameBuf, chunk]);
  onFrames();
});
child.stderr.on("data", (d) => {
  const l = d.toString();
  if (/stdio mode ready|Provider Registry|client connected/.test(l)) console.log(`  [srv] ${l.trim().slice(0, 120)}`);
  rec("err-srv", l.slice(0, 500));
});
child.on("exit", (code) => { rec("exit", `code=${code}`); console.log(`\n== fim · sawTurn=${sawTurn}`); process.exit(sawTurn ? 0 : 2); });

// Initialize ([200]) assim que o hello for respondido
const waitReady = new Promise((r) => {
  const t = setInterval(() => { if (helloDone) { clearInterval(t); r(); } }, 50);
});
await waitReady;
await new Promise((r) => setTimeout(r, 2500)); // boot (billing/providers)
send(rpcFrame([200], undefined));
await new Promise((r) => setTimeout(r, 300));

console.log(`# roundtrip · cwd=${CWD} · goal="${GOAL}"`);
// nível de SERVIÇO (canal zcode-agent): createSession {workspacePath} → sendPrompt {sessionId, workspacePath, text}
const created = await request("zcode-agent", "createSession", { workspacePath: CWD }, 45000);
console.log(`\n== createSession → tipo ${created.type ?? "?"}: ${JSON.stringify(created).slice(0, 700)}`);

if (created.type !== 201) {
  console.log("\n# createSession não aceitou — evidência acima (erro orienta o próximo passo)");
  child.kill();
  process.exit(2);
}
const d = created.data ?? {};
const sessionId = d.sessionId ?? d.session?.id ?? d.snapshot?.session?.id ?? null;
console.log(`\n== sessionId extraído: ${sessionId} (keys: ${Object.keys(d).join(",")})`);

// tenta assinar eventos da conversa (nome/arg exatos são descoberta do probe)
const sub = await request("zcode-agent", "v4/conversation/subscribe", { sessionId }, 8000);
console.log(`== subscribe → tipo ${sub.type}: ${JSON.stringify(sub.data).slice(0, 300)}`);

const sent = await request("zcode-agent", "sendPrompt", { sessionId, workspacePath: CWD, text: GOAL }, 45000);
console.log(`== sendPrompt → tipo ${sent.type}: ${JSON.stringify(sent.data).slice(0, 500)}`);

const deadline = Date.now() + 90_000;
while (!sawTurn && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
child.kill();
process.exit(sawTurn ? 0 : 2);
