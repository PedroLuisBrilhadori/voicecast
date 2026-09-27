#!/usr/bin/env node
/**
 * probe-acp.mjs — C1 do PLANO-COCKPIT: conversa com o zcode-server pelo
 * stdio (ndjson) e documenta o protocolo REAL (envelope, schemas, eventos).
 *
 * Sequência: initialize → session/create {cwd} → send do goal mínimo →
 * espera de turn.*. Transcript completo em probe-log.jsonl (fonte do
 * RESULTADOS.md). Exit 0 se viu turn.completed (ou equivalente).
 *
 * Uso: node probe-acp.mjs [--cwd DIR] [--goal "texto"]
 * Env: ZCODE_SERVER_NODE / ZCODE_SERVER_CJS (defaults de ~/.zcode).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = fs.createWriteStream(path.join(here, "probe-log.jsonl"));
const NODE = process.env.ZCODE_SERVER_NODE || path.join(os.homedir(), ".zcode/server/node");
const CJS = process.env.ZCODE_SERVER_CJS || path.join(os.homedir(), ".zcode/server/zcode-server.cjs");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CWD = flag("--cwd", path.join(os.homedir(), "programing/projetos"));
const GOAL = flag("--goal", "Responda somente: ok");

const child = spawn(NODE, [CJS], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let nextId = 1;
let helloAcked = false;
const pending = new Map(); // id → {resolve, timer}
let sawTurnCompleted = false;
let lastEvents = [];

const record = (dir, obj) => {
  const line = JSON.stringify({ dir, at: new Date().toISOString(), ...obj });
  log.write(line + "\n");
  const short = typeof obj.data === "string" ? obj.data.slice(0, 300) : JSON.stringify(obj.data)?.slice(0, 300);
  console.log(`${dir === "in" ? "◀" : "▶"} ${short ?? ""}`);
};

const onLine = (line) => {
  if (!line.trim()) return;
  record("in", { data: line });
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // linha não-JSON (banner etc.)
  }
  // handshake: o server saúda primeiro; cliente responde zcode-hello-ack
  if (msg.type === "zcode-hello" && !helloAcked) {
    helloAcked = true;
    send({ type: "zcode-hello-ack", version: "1.0.0-voicecast-probe", clientId: "voicecast-probe" });
    return;
  }
  if (msg.method) lastEvents.push(`${msg.method}`);
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    resolve(msg);
  }
  if (typeof msg.method === "string" && /turn\.(completed|failed)|session\.event/.test(msg.method)) {
    if (/turn\.completed|turn\.failed/.test(msg.method)) sawTurnCompleted = true;
  }
};

createInterface({ input: child.stdout }).on("line", onLine);
createInterface({ input: child.stderr }).on("line", (l) => record("err", { data: l }));

child.on("exit", (code, sig) => {
  record("exit", { data: `code=${code} sig=${sig}` });
  process.exit(sawTurnCompleted ? 0 : 2);
});

const send = (obj) => {
  const line = JSON.stringify(obj);
  record("out", { data: line });
  child.stdin.write(line + "\n");
};

const rpc = (method, params, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, error: { message: `TIMEOUT ${method} (${timeoutMs}ms)` } });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    send({ id, method, params });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sequência do probe ─────────────────────────────────────────
console.log(`# probe-acp · server=${CJS}\n# cwd=${CWD} · goal="${GOAL}"`);

await sleep(1500); // linhas espontâneas (banner/hello?)

// varre candidatos de entrada — quem responder define a superfície viva
const candidates = [
  ["runtime/capabilities", {}],
  ["session/list", {}],
  ["v4/commands/query", {}],
];
const alive = [];
for (const [m, p] of candidates) {
  const r = await rpc(m, p, 8000);
  const ok = !r.error;
  console.log(`\n== ${m} → ${ok ? "OK " : "ERR"} ${JSON.stringify(r.result ?? r.error).slice(0, 300)}`);
  if (ok) alive.push(m);
}
if (!alive.length) {
  console.log("\n# nenhum método respondeu — transcript acima é a evidência");
  child.kill();
  process.exit(2);
}

const created = await rpc("session/create", { cwd: CWD }, 30000);
console.log(`\n== session/create → ${JSON.stringify(created).slice(0, 400)}`);
const sessionId = created?.result?.sessionId ?? created?.result?.id ?? null;

if (!sessionId) {
  console.log("\n# sem sessionId — transcript acima documenta o schema de create");
  child.kill();
  process.exit(2);
}

await rpc("session/subscribe", { sessionId }).catch(() => {});
const sent = await rpc("session/send", { sessionId, text: GOAL });
console.log(`\n== session/send → ${JSON.stringify(sent).slice(0, 400)}`);

// espera eventos de turno (até 90s)
const deadline = Date.now() + 90_000;
while (!sawTurnCompleted && Date.now() < deadline) await sleep(1000);

console.log(`\n== fim · sawTurnCompleted=${sawTurnCompleted} · eventos vistos: ${[...new Set(lastEvents)].join(", ") || "(nenhum)"}`);
child.kill();
process.exit(sawTurnCompleted ? 0 : 2);
