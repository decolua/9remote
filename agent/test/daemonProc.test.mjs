// Unit tests for the agent's side of a managed process (features/ai/proc/daemonProc.js).
// Run: node agent/test/daemonProc.test.mjs
//
// No daemon and no CLI: the client is injected, so these assert the two properties a
// live daemon cannot easily produce on demand — a fetch racing a live line, and a
// restart under the same proc id (which is what a mid-chat model change does).
import assert from "node:assert/strict";
import { DaemonProc, decodeLine } from "../features/ai/proc/daemonProc.js";

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

// A stand-in daemon: numbered lines, and a hook that runs BEFORE a request resolves —
// which is how a live line racing a fetch is reproduced on purpose.
function makeClient() {
  const handlers = new Map();
  const state = { lines: [], count: 0, alive: true, started: 0, epoch: 1, oldest: null, onBeforeResolve: null };
  const emit = (event, payload) => {
    for (const h of handlers.get(event) || []) h(payload);
  };
  return {
    state,
    on: (event, h) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(h); },
    off: (event, h) => {
      const list = handlers.get(event) || [];
      const i = list.indexOf(h);
      if (i !== -1) list.splice(i, 1);
    },
    // Test helper: a line the CLI just wrote. The fetch carries base64 (the daemon
    // counts bytes); the live event carries text, because the daemon client decodes it
    // before emitting — mirrored here exactly, or the test would prove nothing.
    pushLine: (text) => {
      state.count++;
      state.lines.push({ n: state.count, enc: "b64", data: Buffer.from(text).toString("base64") });
        emit("procLine", { procId: "p1", epoch: state.epoch, n: state.count, data: text });
    },
    procStart: async () => {
      state.started++;
      // A fresh process owns a fresh stream of numbers — and a fresh epoch, which is
      // what tells a late line or exit of the previous one apart from this one's.
      state.lines = [];
      state.count = 0;
      state.epoch = state.started;
      return { success: true, epoch: state.epoch };
    },
    procLines: async (procId, from) => {
      state.onBeforeResolve?.();
      return { success: true, epoch: state.epoch, lines: state.lines.filter((l) => l.n > from).map((l) => ({ ...l })), total: state.count };
    },
    procAttach: async (procId, from) => ({
      success: true, alive: state.alive, epoch: state.epoch,
      oldest: state.oldest ?? (state.lines[0]?.n ?? state.count + 1),
      lines: state.lines.filter((l) => l.n > from), total: state.count
    }),
    procWrite: async () => ({ success: true }),
    procSignal: async () => ({ success: true }),
    procStop: async () => ({ success: true }),
  };
}

// Starts a proc the way AiSession does: parse the fetched lines, then release.
async function start(proc) {
  const fetch = await proc.start({ bin: "claude", cwd: "/tmp" });
  for (const line of fetch.lines) proc.onLine?.(decodeLine(line));
  fetch.release();
}

console.log("Running managed-process tests...");

await test("a fetched line is handed over once, in order", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const seen = [];
  proc.onLine = (line) => seen.push(decodeLine(line));
  await start(proc);

  client.pushLine("a");
  client.pushLine("b");

  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(proc.lastLine, 2);
});

await test("a line arriving during the fetch is not delivered twice", async () => {
  // The race: the daemon broadcasts a line while procLines is in flight, so the same
  // line is both broadcast and returned by the fetch. Delivering both duplicates a
  // delta in the conversation.
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const seen = [];
  proc.onLine = (line) => seen.push(decodeLine(line));

  // Push exactly one line inside the fetch, after the response is built.
  client.state.onBeforeResolve = () => {
    client.state.onBeforeResolve = null;
    client.pushLine("only-once");
  };
  const fetch = await proc.start({ bin: "claude", cwd: "/tmp" });
  for (const line of fetch.lines) proc.onLine(decodeLine(line));
  fetch.release();

  assert.deepEqual(seen, ["only-once"]);
  assert.equal(proc.lastLine, 1);
});

await test("a restart under the same proc id resumes numbering from 1", async () => {
  // A model/mode change restarts the CLI on the same proc id. Keeping the old
  // watermark would silently drop every line of the new process — the chat would sit
  // silent until the agent restarted again.
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const seen = [];
  proc.onLine = (line) => seen.push(decodeLine(line));
  await start(proc);

  for (let i = 0; i < 5; i++) client.pushLine(`old${i}`);
  assert.equal(proc.lastLine, 5);
  seen.length = 0;

  await start(proc);
  client.pushLine("new0");

  assert.deepEqual(seen, ["new0"]);
});

await test("an exit stops delivering and reports itself once", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const exits = [];
  proc.onExit = (info) => exits.push(info);

  await start(proc);
  client.state.alive = false;
  proc._handleExit({ procId: "p1", epoch: 1, code: 1, signal: null });

  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
  assert.equal(proc.dead, true);
  // The handlers are gone: a second exit from a dead process must not re-report.
  proc._handleExit({ procId: "p1", epoch: 1, code: 1, signal: null });
  assert.equal(exits.length, 1);
});

await test("the replaced process's late exit does not kill the new one", async () => {
  // A restart SIGINTs the old CLI; its exit can land AFTER the new process is already
  // subscribed. Acting on it unsubscribes the new process and the chat goes silent for
  // good — this was a real failure, not a hypothetical one.
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const exits = [];
  const seen = [];
  proc.onExit = (info) => exits.push(info);
  proc.onLine = (line) => seen.push(decodeLine(line));
  await start(proc);

  await start(proc);              // the restart: epoch 2 is now current
  proc._handleExit({ procId: "p1", epoch: 1, code: null, signal: "SIGINT" });

  assert.deepEqual(exits, [], "the old process's exit was taken as the current one's");
  assert.equal(proc.dead, false);
  assert.equal(proc.attached, true, "the new process's subscription was torn down");

  client.pushLine("after-restart");
  assert.deepEqual(seen, ["after-restart"]);
});

await test("the replaced process's late line is dropped", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const seen = [];
  proc.onLine = (line) => seen.push(decodeLine(line));
  await start(proc);
  await start(proc);

  proc._handleLine({ procId: "p1", epoch: 1, n: 99, data: Buffer.from("stale").toString("base64") });
  assert.deepEqual(seen, []);
});

await test("re-attaching a dead process reports it, and adopts nothing", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  client.state.alive = false;
  const res = await proc.attach(0);
  assert.equal(res.alive, false);
  assert.equal(proc.dead, true);
  // Nothing to wait for: the exit already happened.
  assert.equal(proc.attached, false);
});

await test("a ring that dropped lines reports how many were missed", async () => {
  // The daemon's buffer is finite. Without this the reader parses what is left and the
  // conversation comes back with a silent hole where the dropped lines were.
  const client = makeClient();
  // No reader yet — this is the restart case: the process ran on while no agent was
  // attached, so the lines were written but never delivered to anyone.
  const proc = new DaemonProc({ procId: "p1", client });
  proc.onLine = () => {};
  for (let i = 0; i < 10; i++) client.pushLine(`l${i}`);
  // Lines 1-4 were dropped by the ring before this reader came back.
  client.state.lines = client.state.lines.filter((l) => l.n > 4);
  client.state.oldest = 5;

  const res = await proc.attach(0);
  assert.equal(res.missed, 4, "the reader must be told what it can no longer fetch");
});

await test("nothing is reported missed when the ring still holds everything", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  proc.onLine = () => {};
  await start(proc);
  client.pushLine("a");
  client.pushLine("b");
  const res = await proc.attach(0);
  assert.equal(res.missed, 0);
});

await test("a line for another proc is ignored", async () => {
  const client = makeClient();
  const proc = new DaemonProc({ procId: "p1", client });
  const seen = [];
  proc.onLine = (line) => seen.push(decodeLine(line));
  await start(proc);

  proc._handleLine({ procId: "someone-else", n: 99, data: Buffer.from("foreign").toString("base64") });
  assert.deepEqual(seen, []);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
