// E2E test for the deployed signaling DO — verifies the relay round-trips
// offer/answer/ice/error between an agent and a client role, exactly as the
// ProtocolManager + SignalingClient will use it in production.
//
// NOT a unit test: hits a real DO. Run after `npm run web:deploy:dev`.
//
// Usage:
//   node web/test/signaling-do-e2e.test.mjs <baseUrl> <apiKey>
//   node web/test/signaling-do-e2e.test.mjs wss://dev.9remote.cc/signaling <apiKey>
//
// The apiKey must have a live session row (Worker gates on it). Create one first
// via POST /api/connect, or just use the key you'd connect the app with.

const BASE = process.argv[2] || "wss://dev.9remote.cc/signaling";
const APIKEY = process.argv[3] || "";
const ROOM = "e2e-" + Math.random().toString(36).slice(2, 10);

let pass = 0, fail = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  cond ? pass++ : fail++;
};

if (!APIKEY) {
  console.error("Usage: node signaling-do-e2e.test.mjs <baseUrl> <apiKey>");
  console.error("  apiKey is required — the Worker gates WS upgrade on a live session.");
  process.exit(2);
}

const CASES = [
  { type: "offer", sdp: "v=0\r\no=- 123 IN IP4 0.0.0.0\r\ns=-\r\n" },
  { type: "answer", sdp: "v=0\r\no=- 456 IN IP4 1.1.1.1\r\ns=-\r\n" },
  { type: "ice", candidate: "candidate:842163049 1 udp 1677729535 192.0.2.3 61415 typ srflx", mid: "0" },
  { type: "error", message: "Answer timeout" }
];

function sigData(msg) {
  if (msg.type === "offer" || msg.type === "answer") return { sdp: msg.sdp };
  if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
  return msg;
}

function open(role) {
  const ws = new WebSocket(`${BASE}/ws/${ROOM}?role=${role}&apiKey=${encodeURIComponent(APIKEY)}`);
  const queue = [];
  const opened = () => new Promise((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
  ws.addEventListener("message", (e) => {
    if (e.data !== "pong") {
      const { type, payload } = JSON.parse(e.data);
      queue.push({ type, ...payload });
    }
  });
  const send = (msg) => {
    const to = role === "agent" ? "client" : "agent";
    ws.send(JSON.stringify({ to, from: role, type: msg.type, payload: sigData(msg) }));
  };
  return { ws, opened, send, queue };
}

try {
  const agent = open("agent");
  const client = open("client");
  await Promise.all([agent.opened(), client.opened()]);
  assert(true, "both roles connected to the DO room");

  agent.send(CASES[0]); // offer → client
  agent.send(CASES[2]); // ice  → client
  client.send(CASES[1]); // answer → agent
  client.send(CASES[3]); // error  → agent

  await new Promise((r) => setTimeout(r, 1500));

  const find = (q, type) => q.find((m) => m.type === type);
  const co = find(client.queue, "offer");
  const ci = find(client.queue, "ice");
  const ca = find(agent.queue, "answer");
  const ce = find(agent.queue, "error");

  assert(co && co.sdp === CASES[0].sdp, "offer round-trips agent→client unchanged");
  assert(ci && ci.candidate === CASES[2].candidate && ci.mid === CASES[2].mid, "ice round-trips agent→client unchanged");
  assert(ca && ca.sdp === CASES[1].sdp, "answer round-trips client→agent unchanged");
  assert(ce && ce.message === CASES[3].message, "error round-trips client→agent unchanged");

  // Auth gate: a bad apiKey must be rejected (no relay to the room).
  const bad = new WebSocket(`${BASE}/ws/${ROOM}?role=client&apiKey=invalid`);
  const badResult = await new Promise((res) => {
    bad.addEventListener("open", () => res("opened")); // shouldn't happen
    bad.addEventListener("close", (e) => res("closed:" + e.code));
    bad.addEventListener("error", () => res("error"));
    setTimeout(() => res("timeout"), 3000);
  });
  assert(badResult !== "opened", `bad apiKey rejected (${badResult})`);
} catch (err) {
  console.error("ERROR:", err.message);
  fail++;
} finally {
  try { agent?.ws.close(); } catch {}
  try { client?.ws.close(); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
