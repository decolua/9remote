// Tests AI chat persistence across agent restarts via daemon.
// Run: node agent/test/aiChatSurvivesRestart.e2e.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const DAEMON_SRC = path.join(root, "agent/features/terminal/ptyDaemon.js");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-home-"));
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty-e2e"
  : path.join(TEST_HOME, "pty-daemon.sock");

const DEADLINE_MS = 30000;
let cleanup = () => {};
const deadline = setTimeout(() => {
  console.error(`\n✗ timed out after ${DEADLINE_MS / 1000}s — a phase never resolved`);
  cleanup();
  process.exit(1);
}, DEADLINE_MS);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

const FAKE_CLAUDE = `#!/usr/bin/env node
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "fake-model", tools: [], skills: [], slash_commands: [] });
let turn = 0;
let n = 0;
setInterval(() => {
  if (n === 0) { turn++; }
  n++;
  if (n > 2) { n = 1; turn++; }
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "t" + turn + "c" + n + " " } } });
  if (n === 2) out({ type: "control_request", request_id: "req-" + turn, request: { tool_name: "Bash", input: { command: "echo hi" } } });
}, 40);
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "control_response") {
      out({ type: "assistant", message: { content: [{ type: "text", text: "answered:" + msg.response.response.behavior }] } });
    }
    if (msg.type === "user" && /FLOOD/.test(JSON.stringify(msg.message || {}))) {
      const big = "z".repeat(60000);
      for (let i = 0; i < 12; i++) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: big } } });
      }
    }
  }
});

const fs = require("fs");
const path = require("path");
const os2 = require("os");
const transcriptFile = path.join(os2.homedir(), ".claude", "projects", "-fake", SESSION_ID + ".jsonl");
const writeTranscript = () => {
  try {
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      rows.push(JSON.stringify({ type: "user", sessionId: SESSION_ID, message: { role: "user", content: [{ type: "text", text: "turn " + i }] } }));
      rows.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply " + i }] } }));
    }
    fs.writeFileSync(transcriptFile, rows.join("\\n") + "\\n");
  } catch {}
};
writeTranscript();
setInterval(writeTranscript, 200);
`;

function makeFakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-fakeclaude-"));
  fs.writeFileSync(path.join(dir, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  return dir;
}

const AGENT_CHILD = path.join(os.tmpdir(), `9remote-agent-child-${process.pid}.mjs`);

function writeAgentChild() {
  fs.writeFileSync(AGENT_CHILD, `
import { AiSession } from ${JSON.stringify(path.join(root, "agent/features/ai/aiSession.js"))};
import { initDaemonClient } from ${JSON.stringify(path.join(root, "agent/features/terminal/ptyDaemonClient.js"))};

const [sessionId, cwd] = process.argv.slice(2);
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

await initDaemonClient();
const session = new AiSession({
  id: sessionId,
  engine: "claude",
  cwd,
  options: {},
  onEvent: (id, event, data) => say({ kind: "event", event, data })
});
await session.ready;
say({ kind: "ready", history: session.history.map((e) => e.event), adopted: Boolean(session.adopted), missed: session.lastMissed || 0 });

if (process.env.CHILD_PERMISSION) session.adapter.resolvePermission(process.env.CHILD_PERMISSION, "allow");
if (process.env.CHILD_PROMPT) session.sendPrompt(process.env.CHILD_PROMPT);
if (process.env.CHILD_MODE) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const fetch = await session.adapter.setOptions({ mode: process.env.CHILD_MODE });
    session._replay(fetch);
    say({ kind: "restarted", mode: process.env.CHILD_MODE, fetchLines: fetch?.lines?.length ?? -1,
          lastLine: session.proc?.lastLine, consumed: session.consumedLines, dead: session.proc?.dead });
  } catch (e) {
    say({ kind: "restarted", mode: process.env.CHILD_MODE, error: e.message });
  }
  await new Promise((r) => setTimeout(r, 500));
  say({ kind: "after", lastLine: session.proc?.lastLine, consumed: session.consumedLines,
        deltas: session.history.filter((e) => e.event === "delta").length });
}
setInterval(() => {}, 1 << 30);
`, "utf8");
}

function connectDaemon() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    let buf = "";
    const pending = new Map();
    const events = [];
    const waiters = [];
    let id = 0;
    sock.on("connect", () => resolve({
      events,
      send: (msg) => new Promise((res) => {
        const rid = ++id;
        pending.set(rid, res);
        sock.write(JSON.stringify({ ...msg, requestId: rid }) + "\n");
      }),
      waitFor: (match, ms = 5000) => {
        const seen = events.find(match);
        if (seen) return Promise.resolve(seen);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error("timed out waiting for daemon event")), ms);
          waiters.push((msg) => {
            if (!match(msg)) return false;
            clearTimeout(timer);
            res(msg);
            return true;
          });
        });
      },
      close: () => sock.destroy()
    }));
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.requestId && pending.has(msg.requestId)) {
          pending.get(msg.requestId)(msg);
          pending.delete(msg.requestId);
          continue;
        }
        events.push(msg);
        for (const w of waiters.slice()) if (w(msg)) waiters.splice(waiters.indexOf(w), 1);
      }
    });
  });
}

const liveChildren = [];

function startChild(env, sessionId = "chat-1") {
  const child = spawn(process.execPath, [AGENT_CHILD, sessionId, daemonDir], {
    cwd: root,
    env: {
      ...process.env,
      NREMOTE_HOME: TEST_HOME,
      HOME: TEST_HOME,
      NREMOTE_CLAUDE_BIN: path.join(fakeDir, "claude"),
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`, ...env
    },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const state = { events: [], signals: [], ready: null, child };
  liveChildren.push(state);
  child.stdout.on("data", (c) => {
    for (const line of c.toString().split("\n")) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.kind === "ready") state.ready = msg;
      else if (msg.kind === "event") state.events.push(msg);
      else { state.signals.push(msg); if (process.env.DUMP) console.log("SIGNAL", JSON.stringify(msg)); }
    }
  });
  return state;
}

const deltasOf = (state) => state.events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");

const fakeDir = makeFakeClaude();
const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-daemon-"));
writeAgentChild();

const daemon = spawn(process.execPath, [DAEMON_SRC], {
  cwd: path.dirname(DAEMON_SRC),
  env: {
    ...process.env,
    NREMOTE_HOME: TEST_HOME,
    HOME: TEST_HOME,
    NREMOTE_CLAUDE_BIN: path.join(fakeDir, "claude"),
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`
  },
  stdio: ["ignore", "inherit", "inherit"]
});
await wait(500);

let client, child, revived;
cleanup = () => {
  clearTimeout(deadline);
  for (const st of liveChildren) { try { st.child.kill("SIGKILL"); } catch {} }
  client?.close();
  try { daemon.kill("SIGTERM"); } catch {}
  try {
    const pid = parseInt(fs.readFileSync(path.join(TEST_HOME, "pids", "ptyDaemon.pid"), "utf8"), 10);
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
  fs.rmSync(fakeDir, { recursive: true, force: true });
  fs.rmSync(daemonDir, { recursive: true, force: true });
  try { fs.unlinkSync(AGENT_CHILD); } catch {}
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
try {
  client = await connectDaemon();
  console.log("Running AI chat restart tests...\n");

  await test("the daemon runs a CLI process without knowing what it speaks", async () => {
    const started = await client.send({ type: "procStart", procId: "chat-1", bin: "claude", args: [], cwd: daemonDir, env: {} });
    assert.equal(started.success, true, `procStart failed: ${started.error}`);
    await client.waitFor((m) => m.type === "procLine" && m.procId === "chat-1");
    const all = await client.send({ type: "procLines", procId: "chat-1", from: 0 });
    assert.equal(all.success, true);
    assert.ok(all.lines.length > 0, "no lines buffered");
    assert.match(unb64(all.lines[0].data), /"subtype":"init"/);
  });

  await test("procLines returns only the lines after `from`, numbered consecutively", async () => {
    const from = 4;
    let res;
    for (let i = 0; i < 50; i++) {
      res = await client.send({ type: "procLines", procId: "chat-1", from });
      if (res.lines.length > 0) break;
      await wait(50);
    }
    assert.ok(res.lines.length > 0);
    assert.deepEqual(res.lines.map((l) => l.n), res.lines.map((_, i) => from + i + 1));
    assert.equal(res.total, from + res.lines.length);
  });

  await test("procAttach adopts the running process instead of starting a second one", async () => {
    const attached = await client.send({ type: "procAttach", procId: "chat-1", from: 1 });
    assert.equal(attached.success, true);
    assert.equal(attached.alive, true);
    assert.deepEqual(attached.lines.map((l) => l.n), attached.lines.map((_, i) => i + 2));
  });

  await test("an agent that dies mid-turn loses no line of that turn", async () => {
    child = startChild({ CHILD_PROMPT: "hello" });
    while (!child.ready) await wait(30);
    while (!deltasOf(child)) await wait(20);
    const snapDir = path.join(TEST_HOME, "ai-sessions");
    for (let i = 0; i < 150 && !(fs.existsSync(snapDir) && fs.readdirSync(snapDir).length); i++) await wait(20);
    const onDisk = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
    assert.ok(onDisk.length > 0, "no snapshot was written while the turn was running");
    child.child.kill("SIGKILL");
    await wait(250);

    const before = child.events.filter((e) => e.event === "delta").length;
    assert.ok(before > 0, "the turn should have streamed before the agent died");

    if (process.env.DUMP) {
      const dir = path.join(TEST_HOME, "ai-sessions");
      console.log("SNAPSHOT:", fs.existsSync(dir) ? fs.readdirSync(dir).join(",") : "none");
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        console.log("  ", f, "consumed:", snap.consumedLines, "events:", snap.events.map((e) => e.event).join(","));
        console.log("  first:", JSON.stringify(snap.events[0]).slice(0, 300));
      }
      console.log("  child1 events:", child.events.slice(0, 6).map((e) => e.event + ":" + JSON.stringify(e.data).slice(0, 80)).join("\n    "));
    }
    revived = startChild({});
    while (!revived.ready) await wait(30);
    await wait(400);

    assert.ok(revived.ready.history.includes("delta"), `history lost its deltas: ${JSON.stringify(revived.ready.history)}`);
    assert.equal(revived.ready.adopted, true);
    const revivedText = deltasOf(revived);
    assert.ok(revivedText.length > 0, "the revived agent saw no new output from the live turn");
    const tail = deltasOf(child).slice(-40);
    assert.ok(!revivedText.startsWith(tail), "the revived agent replayed text the first one had already streamed");
  });

  await test("a mode switch mid-chat keeps the new process's output flowing", async () => {
    const ch = startChild({ CHILD_MODE: "plan" }, "chat-mode");
    while (!ch.ready) await wait(30);
    const restarted = await (async () => {
      for (let i = 0; i < 200; i++) {
        const ev = ch.signals.find((e) => e.kind === "restarted");
        if (ev) return ev;
        await wait(30);
      }
      return null;
    })();
    assert.ok(restarted, "the child never reported the restart");
    assert.equal(restarted.mode, "plan");

    const before = ch.events.filter((e) => e.event === "delta").length;
    for (let i = 0; i < 100 && ch.events.filter((e) => e.event === "delta").length <= before; i++) await wait(30);
    const after = ch.events.filter((e) => e.event === "delta").length;
    assert.ok(after > before, "no output arrived after the restart");
    ch.child.kill("SIGKILL");
  });

  await test("a permission answer reaches the running CLI", async () => {
    const res = await client.send({
      type: "procWrite",
      procId: "chat-1",
      data: b64(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "req-1", response: { behavior: "allow" } } }) + "\n")
    });
    assert.equal(res.success, true);
    await client.waitFor((m) => m.type === "procLine" && m.procId === "chat-1" && unb64(m.data).includes("answered:allow"), 4000);
  });

  await test("a ring the agent outran is healed from the CLI's transcript", async () => {
    const ch = startChild({}, "chat-gap");
    while (!ch.ready) await wait(30);
    const snapFile = path.join(TEST_HOME, "ai-sessions", "claude-chat-gap.json");
    for (let i = 0; i < 150 && !fs.existsSync(snapFile); i++) await wait(20);
    assert.ok(fs.existsSync(snapFile), "the session was killed before it persisted anything");
    assert.ok(JSON.parse(fs.readFileSync(snapFile, "utf8")).cliSessionId, "the snapshot carried no conversation id");
    ch.child.kill("SIGKILL");
    await wait(200);

    const flood = Buffer.from(JSON.stringify({
      type: "user", message: { role: "user", content: [{ type: "text", text: "FLOOD" }] }
    }) + "\n").toString("base64");
    await client.send({ type: "procWrite", procId: "chat-gap", data: flood });
    let trimmed = false;
    for (let i = 0; i < 200; i++) {
      const p = await client.send({ type: "procLines", procId: "chat-gap", from: 0 });
      if (p.oldest > 1) { trimmed = true; break; }
      await wait(50);
    }
    assert.ok(trimmed, "the ring never filled, so no gap could be created");

    const back = startChild({}, "chat-gap");
    while (!back.ready) await wait(30);
    assert.ok(back.ready.missed > 0, `no gap was detected (missed=${back.ready.missed})`);
    assert.ok(back.ready.history.includes("user_message"),
      `the conversation was not rebuilt: ${JSON.stringify(back.ready.history.slice(0, 12))}`);
    assert.ok(back.ready.history.length > 2, "the rebuilt log carried no turns");
    back.child.kill("SIGKILL");
  });

  await test("procStop ends the process and reports the exit once", async () => {
    const stopped = await client.send({ type: "procStop", procId: "chat-1" });
    assert.equal(stopped.success, true);
    await client.waitFor((m) => m.type === "procExit" && m.procId === "chat-1" && (m.code !== null || Boolean(m.signal)), 5000);
    const gone = await client.send({ type: "procLines", procId: "chat-1", from: 0 });
    assert.equal(gone.success, false);
  });
} finally {
  cleanup();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
