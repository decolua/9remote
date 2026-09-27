// E2E: a chat-UI session must survive an agent restart the way a terminal does.
// Run: node agent/test/aiChatRestoreE2E.test.mjs
//
// The agent is booted for real, twice, over one temp root, and everything is
// driven over the same surfaces the app uses: a socket.io client for the
// session list, the local notify endpoint for the CLI's own hook. Nothing is
// written by the test between the two boots — whatever the second boot knows,
// it learned on its own. That is the property under test.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT = path.join(root, "host/index.js");

// A private root for the whole run: sessions.json, the daemon socket and the chat
// snapshots all land here, so a live agent on this machine is neither disturbed
// nor able to leak its own sessions into the assertions.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-chat-restart-"));
const PORT = 2300 + (process.pid % 300);

// Loopback admission: the embedded workspace presents the key's tail. Written
// before the first boot, which is the only reader of this file.
const KEY = "sk-abcd1234-qrstuvwx-mnpqrstu";
fs.writeFileSync(path.join(HOME, "keys.json"), JSON.stringify({ key: KEY }));

const DEADLINE_MS = 120000;
// The deadline must go through cleanup() — a bare process.exit() skips the finally
// below and leaks the agents + daemon this run spawned.
let cleanup = () => {};
const deadline = setTimeout(() => {
  console.error(`\n✗ timed out after ${DEADLINE_MS / 1000}s — a phase never resolved`);
  cleanup();
  process.exit(1);
}, DEADLINE_MS);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Agent child ───────────────────────────────────────────────────────────────
// Its own process, because the test kills it: a restart only means something if
// the first process is really gone.
function startAgent() {
  const child = spawn(process.execPath, [AGENT], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), NREMOTE_HOME: HOME, HOME },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

const base = `http://127.0.0.1:${PORT}`;

/** Poll the local API until the server answers. */
async function waitForServer(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) return true;
    } catch {}
    await wait(200);
  }
  return false;
}

/** Wait for the port to be free again — a second boot that races the old
 *  listener would bind-fail and report nothing. */
async function waitForPortFree(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const taken = await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
    });
    if (!taken) return true;
    await wait(150);
  }
  return false;
}

// ── One browser ───────────────────────────────────────────────────────────────
// Loopback + a verified key tail is how the embedded workspace is admitted, so
// this rides the real path rather than a test-only door.
function connect() {
  const socket = io(base, {
    transports: ["websocket"],
    reconnection: false,
    auth: { deviceId: `e2e-${process.pid}`, keyTail: "mnpqrstu" }
  });
  const ready = new Promise((resolve, reject) => {
    socket.on("connect", () => { socket.emit("device:clientReady"); resolve(); });
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("socket never connected")), 15000);
  });
  // Some handlers take only the ack (getSessions); an explicit `undefined`
  // payload would land in the callback slot and the ack would never be called.
  const call = (event, payload) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    const ack = (res) => { clearTimeout(timer); resolve(res); };
    if (payload === undefined) socket.emit(event, ack);
    else socket.emit(event, payload, ack);
  });
  return { socket, ready, call };
}

const agentOf = (list, id) => (Array.isArray(list) ? list.find((s) => s.id === id) : null) || null;

// ── The run ───────────────────────────────────────────────────────────────────
let agent1, agent2, client1, client2;
// The daemon is detached on purpose (it must survive the agent), so the only
// handle left at teardown is the PID file it writes for exactly this. SIGTERM,
// not SIGKILL: the daemon's own shutdown takes its PTYs down with it.
const killDaemonByPid = () => {
  try {
    const pid = parseInt(fs.readFileSync(path.join(HOME, "pids", "ptyDaemon.pid"), "utf8"), 10);
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
};
cleanup = () => {
  clearTimeout(deadline);
  client1?.socket?.close();
  client2?.socket?.close();
  agent1?.kill("SIGKILL");
  agent2?.kill("SIGKILL");
  killDaemonByPid();
  // Best effort: a daemon child may still be writing into the tree, and a
  // cleanup failure must not mask the assertion that actually failed.
  try { fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
try {
  console.log("Running chat-survives-restart tests...\n");

  agent1 = startAgent();
  assert.ok(await waitForServer(), `the agent never came up on ${PORT}`);

  client1 = connect();
  await client1.ready;

  const CONV_ID = "11111111-2222-3333-4444-555555555555";

  // A chat-UI session, made the way the UI makes one: a terminal whose agent is
  // the chat surface.
  const created = await client1.call("createSession", {
    name: "E2E Chat", shellId: null, workspaceId: null, cwd: HOME, agent: "claude-ui"
  });
  assert.ok(created?.success, `createSession failed: ${JSON.stringify(created)}`);
  const SID = created.sessionId;

  // The host learns the conversation from the CLI's own hook — the same POST the
  // installed hook makes. This is what puts the id in sessions.json, and the
  // link a chat pane reopens by.
  const hooked = await fetch(`${base}/api/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "stop", sessionId: SID, tool: "claude", csid: CONV_ID })
  });
  assert.ok(hooked.ok, `the notify hook was refused: ${hooked.status}`);
  await wait(300);

  const before = await client1.call("getSessions", undefined);
  const chatBefore = agentOf(before, SID);
  assert.ok(chatBefore, `the chat is missing from getSessions before any restart: ${JSON.stringify(before)}`);
  assert.equal(chatBefore.agent, "claude-ui", "the chat surface must travel to the client");

  // The link must be on disk BEFORE the kill, or the restart has nothing to read.
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "state/sessions.json"), "utf8"));
  assert.equal(onDisk[SID]?.conversationId, CONV_ID,
    `the conversation was never persisted: ${JSON.stringify(onDisk[SID])}`);

  // ── The restart ─────────────────────────────────────────────────────────────
  agent1.kill("SIGKILL");
  agent1 = null;
  await waitForPortFree();

  agent2 = startAgent();
  assert.ok(await waitForServer(), "the agent never came back up");

  client2 = connect();
  await client2.ready;

  const after = await client2.call("getSessions", undefined);
  const chatAfter = agentOf(after, SID);

  await test("a chat-UI session survives an agent restart", () => {
    assert.ok(chatAfter, `the chat vanished across the restart: ${JSON.stringify(after)}`);
  });

  await test("it comes back as a chat, not a plain terminal", () => {
    // The pane picks chat vs terminal by this string, so a chat that comes back
    // as its bare engine reopens as an ordinary terminal — which is what the
    // user sees as "the session is gone".
    assert.ok(chatAfter, "no chat to check");
    assert.equal(chatAfter.agent, "claude-ui",
      "the chat surface was lost, so the pane reopens as a bare terminal");
  });

  await test("the conversation it was running is still linked on the host", () => {
    // The link is what a reopened pane resumes instead of starting a new chat.
    // Read back off the host's own state, not a field invented for the test.
    const reloaded = JSON.parse(fs.readFileSync(path.join(HOME, "state/sessions.json"), "utf8"));
    assert.equal(reloaded[SID]?.conversationId, CONV_ID,
      "the conversation link was lost across the restart");
  });
} finally {
  cleanup();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
