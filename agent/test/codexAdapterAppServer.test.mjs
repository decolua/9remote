// The CodexAdapter driving the app-server instead of `exec --json`.
//
// This is the seam where the two transports meet the rest of the app, and the place a
// mistake is expensive: the adapter is what `aiSession` calls for every turn, permission
// answer and mode change. The rules it has to keep are the ones ClaudeAdapter already
// keeps — one process for the chat, the same method names, the same events out — so a
// session cannot tell which transport its engine got.
//
// Run: node agent/test/codexAdapterAppServer.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// A proc that records writes and answers the handshake, standing in for the daemon.
function fakeProc() {
  const proc = {
    written: [], onLine: null, onExit: null, started: null, stops: 0, starts: 0,
    write(t) { proc.written.push(t); },
    emit(o) { proc.onLine?.(typeof o === "string" ? o : JSON.stringify(o)); },
    sent(m) { return proc.written.map((w) => JSON.parse(w)).filter((x) => x.method === m); },
    async start(opts) {
      proc.started = opts;
      proc.starts = (proc.starts || 0) + 1;
      return { lines: [], after: [], missed: 0, release() {}, commit() {} };
    },
    async attach() { return { lines: [], after: [], missed: 0, alive: false, release() {} }; },
    async stop() { proc.stops = (proc.stops || 0) + 1; },
    write2() {}
  };
  return proc;
}

// Answers initialize + thread/start so start() resolves, and returns the adapter.
async function startedAdapter({ onEvent = () => {}, ...opts } = {}) {
  const proc = fakeProc();
  const adapter = new CodexAdapter({ cwd: "/w", onEvent, proc, transport: "app-server", ...opts });
  const ready = adapter.start("default", null);
  await Promise.resolve(); await Promise.resolve();
  const init = proc.sent("initialize")[0];
  if (init) proc.emit({ jsonrpc: "2.0", id: init.id, result: { userAgent: "codex/0.154.0" } });
  await Promise.resolve();
  const ts = proc.sent("thread/start")[0];
  if (ts) proc.emit({ jsonrpc: "2.0", id: ts.id, result: { thread: { id: "t-1" } } });
  await ready;
  return { proc, adapter };
}

// ── choosing the transport ──

await test("a chat that says nothing gets the app-server", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  delete process.env.NREMOTE_CODEX_TRANSPORT;
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc() });
    assert.equal(a.transport, "app-server");
  } finally {
    if (before !== undefined) process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

await test("app-server is opt-in and reports itself", () => {
  const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc(), transport: "app-server" });
  assert.equal(a.transport, "app-server");
});

await test("the env var can turn it on, so a deployment needs no code change", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  process.env.NREMOTE_CODEX_TRANSPORT = "app-server";
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc() });
    assert.equal(a.transport, "app-server");
  } finally {
    if (before === undefined) delete process.env.NREMOTE_CODEX_TRANSPORT;
    else process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

// ── the process lifecycle: one per chat, like Claude ──

await test("start spawns the app-server with stdin kept open", async () => {
  const { proc } = await startedAdapter();
  assert.equal(proc.started.bin, "codex");
  assert.deepEqual(proc.started.args.slice(0, 2), ["app-server"]);
  // Turn-per-CLI closed stdin after the handshake; this CLI takes every later turn on
  // it, so closing would end the conversation at birth.
  assert.equal(proc.started.keepStdin, true);
  assert.equal(proc.started.cwd, "/w");
});

await test("the session can tell this engine holds a process, so it starts one", async () => {
  // aiSession only calls start() for engines that keep a process; without this flag a
  // codex chat would never open its connection and the first prompt would go nowhere.
  const { adapter } = await startedAdapter();
  assert.equal(adapter.persistent, true);
  const exec = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc(), transport: "exec" });
  assert.ok(!exec.persistent, "exec spawns per turn and has nothing to start");
});

await test("the thread id from the handshake is kept, so the next turn rejoins it", async () => {
  const { adapter } = await startedAdapter();
  assert.equal(adapter.activeThreadId, "t-1");
});

await test("a resume id is rejoined, not replaced by a fresh thread", async () => {
  const proc = fakeProc();
  const adapter = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc, transport: "app-server", threadId: "t-old" });
  const ready = adapter.start("default", "t-old");
  await Promise.resolve(); await Promise.resolve();
  proc.emit({ jsonrpc: "2.0", id: proc.sent("initialize")[0].id, result: {} });
  await Promise.resolve();
  const rr = proc.sent("thread/resume")[0];
  assert.ok(rr, "a resumed chat must rejoin its thread");
  assert.equal(rr.params.threadId, "t-old");
  proc.emit({ jsonrpc: "2.0", id: rr.id, result: { thread: { id: "t-old" } } });
  await ready;
  assert.equal(proc.sent("thread/start").length, 0, "a second thread would orphan the conversation");
});

// ── turns ──

await test("a prompt is a turn on the SAME process, not a new spawn", async () => {
  const { proc, adapter } = await startedAdapter();
  const before = proc.written.length;
  const p = adapter.sendPrompt("hello");
  const ts = proc.sent("turn/start")[0];
  assert.ok(ts, "the prompt must ride the running server");
  assert.deepEqual(ts.params.input, [{ type: "text", text: "hello", text_elements: [] }]);
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
  assert.equal(adapter.isTurnRunning, true);
  assert.ok(proc.written.length > before);
});

await test("thinking deltas reach the session as thinking events", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  adapter.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  proc.emit({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta",
    params: { threadId: "t-1", turnId: "turn-1", itemId: "rs_1", delta: "thinking…", summaryIndex: 0 } });
  assert.deepEqual(events.filter(([e]) => e === "thinking").map(([, d]) => d.text), ["thinking…"]);
});

await test("a tool call opens and closes a card through the adapter", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  const cmd = { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'ls'", cwd: "/w", status: "inProgress",
    commandActions: [{ type: "listFiles", command: "ls", path: null }], aggregatedOutput: null, exitCode: null };
  proc.emit({ jsonrpc: "2.0", method: "item/started", params: { item: cmd, threadId: "t-1", turnId: "turn-1" } });
  proc.emit({ jsonrpc: "2.0", method: "item/completed",
    params: { item: { ...cmd, status: "completed", aggregatedOutput: "a\n", exitCode: 0 }, threadId: "t-1", turnId: "turn-1" } });

  const start = events.find(([e]) => e === "tool_start")[1];
  assert.equal(start.name, "list_files");
  assert.equal(start.input.command, "ls");
  const result = events.find(([e]) => e === "tool_result")[1];
  assert.equal(result.output, "a\n");
  assert.equal(result.status, "done");
});

await test("turn_completed reaches the session, so the pane stops spinning", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  adapter.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  proc.emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-1", status: "completed" } } });
  assert.equal(events.filter(([e]) => e === "turn_complete").length, 1);
  assert.equal(adapter.isTurnRunning, false);
});

// ── the gate ──

await test("a permission request is surfaced and answered through the adapter", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  proc.emit({ jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval",
    params: { conversationId: "t-1", callId: "c1", approvalId: null, command: ["ls"], cwd: "/w", reason: null, parsedCmd: [] } });

  const req = events.find(([e]) => e === "permission_request")[1];
  assert.equal(req.requestId, "srv-1");
  assert.equal(adapter.resolvePermission("srv-1", "allow"), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.equal(answer.id, "srv-1");
  assert.equal(answer.result.decision, "accept");
});

// The card reads `pendingRequests` to bring a gate back after a replay. Without it a
// reopened chat shows a CLI waiting on an answer nobody can see.
await test("a held gate is remembered in the shape the session reads back", async () => {
  const { proc, adapter } = await startedAdapter();
  proc.emit({ jsonrpc: "2.0", id: "srv-9", method: "execCommandApproval",
    params: { conversationId: "t-1", callId: "c1", command: ["rm", "-rf", "/"], cwd: "/w", parsedCmd: [] } });
  assert.ok(adapter.pendingRequests?.size, "the session reads pendingRequests to restore the card");
  const held = adapter.pendingRequests.get("srv-9");
  assert.match(held.input.command, /rm -rf/);
  assert.equal(held.requestId ?? "srv-9", "srv-9");
});

await test("an answer to a gate nobody is holding is refused", async () => {
  const { adapter } = await startedAdapter();
  assert.equal(adapter.resolvePermission("never-seen", "allow"), false);
});

// ── modes ──

await test("each permission mode maps to the sandbox the server understands", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ mode: "readOnly" });
  assert.equal(adapter.sandboxMode, "read-only");
  adapter.setOptions({ mode: "fullAccess" });
  assert.equal(adapter.sandboxMode, "danger-full-access");
  adapter.setOptions({ mode: "default" });
  assert.equal(adapter.sandboxMode, "workspace-write");
  assert.ok(proc, "the mapping is what thread/start carries");
});

await test("a mode change mid-chat reaches the next turn, not just the next process", () => {
  // Turn-per-CLI could put it in the argv of the next spawn. Here the server is already
  // running, so a mode the user picked has to ride the turn itself.
  const proc = fakeProc();
  const adapter = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc, transport: "app-server" });
  adapter.sandboxMode = "danger-full-access";
  adapter.activeThreadId = "t-1";
  adapter.appServer = { threadId: "t-1", isTurnRunning: false, sendPrompt: () => Promise.resolve(), stop: async () => {} };
  adapter.sendPrompt("hi");
  assert.equal(adapter.sandboxMode, "danger-full-access");
});

// ── dying ──

await test("a server that dies ends the turn, so the pane cannot spin forever", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  adapter.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  proc.onExit?.({ code: 1 });
  assert.equal(adapter.isTurnRunning, false);
  assert.equal(events.filter(([e]) => e === "turn_complete").length, 1);
});

// ── options reaching a live server ──
//
// On the exec transport every option was an argv flag on the turn's own process, so a
// change cost nothing. The process IS the chat here, so an option has to be pushed onto
// it — or, for a feature flag, cost a new process.

await test("a mode change goes to the live thread, not just into metadata", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ mode: "readOnly" });
  const up = proc.sent("thread/settings/update")[0];
  assert.ok(up, "the running server must be told");
  assert.equal(up.params.sandboxPolicy.type, "readOnly");
  assert.equal(up.params.approvalPolicy, "untrusted");
});

await test("plan mode reaches the server as a collaboration mode", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ mode: "plan", planEffort: "xhigh" });
  const up = proc.sent("thread/settings/update").pop();
  assert.equal(up.params.collaborationMode.mode, "plan");
  assert.equal(up.params.collaborationMode.settings.reasoning_effort, "xhigh");
});

await test("network access and extra dirs ride the sandbox policy", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ networkAccess: true, addDirs: ["/tmp/extra"] });
  const up = proc.sent("thread/settings/update").pop();
  assert.equal(up.params.sandboxPolicy.networkAccess, true);
  assert.deepEqual(up.params.sandboxPolicy.writableRoots, ["/tmp/extra"]);
});

// Probed on the real server: thread/start's `config` does NOT apply a feature and
// experimentalFeature/enablement/set changes nothing. Only `-c features.X=true` on the
// process does — so this option is the one that costs a restart.
await test("a feature flag change respawns the server with the flag", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ enable: ["multi_agent_v2"] });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(proc.stops > 0, "the old process must go");
  assert.ok(proc.started.args.includes("features.multi_agent_v2=true"),
    `respawned without the flag: ${JSON.stringify(proc.started.args)}`);
});

await test("the respawn rejoins the same thread, so the chat is not orphaned", async () => {
  const proc = fakeProc();
  const adapter = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc, transport: "app-server" });
  const ready = adapter.start("default", null);
  await Promise.resolve(); await Promise.resolve();
  proc.emit({ jsonrpc: "2.0", id: proc.sent("initialize")[0].id, result: {} });
  await Promise.resolve();
  proc.emit({ jsonrpc: "2.0", id: proc.sent("thread/start")[0].id, result: { thread: { id: "t-keep" } } });
  await ready;

  adapter.setOptions({ enable: ["artifact"] });
  // The respawn is a whole new handshake: initialize, then the thread it rejoins.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const init2 = proc.sent("initialize").pop();
  proc.emit({ jsonrpc: "2.0", id: init2.id, result: {} });
  await new Promise((r) => setImmediate(r));
  const resumed = proc.sent("thread/resume").pop();
  assert.ok(resumed, "a restart must rejoin the thread, not open a new one");
  assert.equal(resumed.params.threadId, "t-keep", "a new thread would lose the conversation");
  assert.equal(proc.sent("thread/start").length, 1, "only the original chat opens a thread");
});

await test("a feature change mid-turn waits instead of killing the answer on screen", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.isTurnRunning = true;
  adapter.setOptions({ disable: ["artifact"] });
  await new Promise((r) => setImmediate(r));
  assert.equal(proc.stops, 0, "the turn in flight must not be dropped");
});

await test("a settings call the server refuses does not take the turn's options with it", async () => {
  const { proc, adapter } = await startedAdapter();
  adapter.setOptions({ mode: "fullAccess" });
  const up = proc.sent("thread/settings/update")[0];
  // The server is gone or refuses; the option still holds for this adapter.
  proc.emit({ jsonrpc: "2.0", id: up.id, error: { message: "nope" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(adapter.permissionMode, "fullAccess");
});

await test("an image attachment reaches the turn as a localImage", async () => {
  const { proc, adapter } = await startedAdapter();
  // What the session hands over is the raw upload; the adapter stages it to a file first,
  // which is where the path a localImage needs comes from.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  adapter.sendPrompt("what is this?", [{ filename: "shot.png", type: "image/png", content: png }]);
  const ts = proc.sent("turn/start")[0];
  const img = ts.params.input.find((i) => i.type === "localImage");
  assert.ok(img, `expected a localImage entry, got ${JSON.stringify(ts.params.input)}`);
  // The staged copy, not the client's filename: the server reads a path on this host.
  assert.match(img.path, /shot\.png$/);
  assert.ok(fs.existsSync(img.path), "the staged file must exist for the server to read it");
});

// A restart swaps the server under a chat that is staying. Three things must not
// happen: the old process's exit must not read as this chat dying, a prompt during the
// gap must not fall through to a second writer, and two restarts must not race.
await test("a prompt during a restart waits instead of spawning an exec turn", async () => {
  const { proc, adapter } = await startedAdapter();
  // Hold the respawn open, so the window is real rather than a race we hope not to hit.
  let release;
  const gate = new Promise((r) => { release = r; });
  const realStart = proc.start.bind(proc);
  proc.start = async (opts) => { await gate; return realStart(opts); };

  const restarting = adapter.restart();
  await Promise.resolve();
  const before = proc.written.length;
  adapter.sendPrompt("during the gap");
  await Promise.resolve();
  const sent = proc.written.slice(before)
    .map((w) => { try { return JSON.parse(w); } catch { return null; } })
    .filter(Boolean);
  assert.equal(sent.filter((m) => m.method === "turn/start").length, 0,
    "a turn must not go out over a half-built server");
  assert.equal(proc.starts, 1, "and it must not have spawned a second process");

  release();
  // The respawn is a whole new handshake; answer it so the restart can finish.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const init2 = proc.sent("initialize").pop();
  proc.emit({ jsonrpc: "2.0", id: init2.id, result: {} });
  await new Promise((r) => setImmediate(r));
  const rr = proc.sent("thread/resume").pop();
  if (rr) proc.emit({ jsonrpc: "2.0", id: rr.id, result: { thread: { id: "t-1" } } });
  await restarting.catch(() => {});
  await new Promise((r) => setImmediate(r));
  // The held prompt went out once the server was back, as a turn on it.
  assert.equal(proc.sent("turn/start").length, 1, "the prompt typed during the restart must not vanish");
});

await test("the old server is unhooked before it is stopped, so its exit is not a crash", async () => {
  const events = [];
  const { proc, adapter } = await startedAdapter({ onEvent: (e, d) => events.push([e, d]) });
  // The handler as it stands right now belongs to the server we are about to replace.
  const oldExit = proc.onExit;
  const restarting = adapter.restart();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(proc.onExit === oldExit, false,
    "the replaced server must be detached, or its exit reads as this chat dying");
  // Its exit, delivered through the hook it had, must reach nobody.
  assert.equal(events.filter(([e]) => e === "error").length, 0,
    `a restart must not look like a crash: ${JSON.stringify(events)}`);
  // Not awaited: the respawn is still opening, and what this test is about already
  // happened. A restart that never gets its handshake answered is the next test's job.
  restarting.catch(() => {});
  adapter.stop();
});

await test("two restarts in flight do not fight over one process", async () => {
  const { proc, adapter } = await startedAdapter();
  const startsBefore = proc.starts;
  const a = adapter.restart();
  const b = adapter.restart();
  await Promise.resolve();
  // The second call must be a no-op while the first is still opening: two respawns would
  // leave one process orphaned, still holding the thread.
  assert.equal(adapter._restarting, true);
  adapter.stop();
  a.catch(() => {}); b.catch(() => {});
});

// The carrier is not a detail. AgentProc — codex's default — only READS the CLI's
// stdout and has no `write()` at all, which is fine for `exec` and fatal for a two-way
// protocol: the first `initialize` went nowhere and came back as a 15s timeout, which
// is exactly what a chat that never answers looks like. Found in the real agent log:
//
//   00:38:44.415 [ai:error] create failed after 15006ms: initialize timed out after 15000ms
await test("the app-server runs on a two-way carrier, never on AgentProc", () => {
  const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, transport: "app-server" });
  const carrier = a._carrierFor();
  assert.equal(typeof carrier.write, "function",
    "the app-server must be able to send; AgentProc has no write()");
  assert.notEqual(carrier.constructor.name, "AgentProc");
});

await test("a carrier is reused across a restart, not leaked", () => {
  const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, transport: "app-server" });
  assert.equal(a._carrierFor(), a._carrierFor(), "a new carrier per start orphans the child");
});

await test("an injected proc still wins, so a test drives its own", () => {
  const mine = fakeProc();
  const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: mine, transport: "app-server" });
  assert.equal(a._carrierFor(), mine);
});

// exec keeps AgentProc: it never writes, and the carrier it already had is the right one.
await test("the exec transport is untouched by the carrier choice", () => {
  const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, transport: "exec" });
  assert.equal(a.proc.constructor.name, "AgentProc");
});

// A carrier that BUFFERS, like the daemon one does. LocalProc has no hold, which is why
// the same code worked without a daemon and hung with one — the failure only exists on
// the path a real chat takes.
function bufferingProc() {
  const proc = fakeProc();
  const held = [];
  proc.start = async (opts) => {
    proc.started = opts;
    proc.starts = (proc.starts || 0) + 1;
    return {
      lines: [], after: [], missed: 0,
      release() { for (const l of held.splice(0)) proc.onLine?.(l); },
      commit(feed) { for (const l of held.splice(0)) feed(l); }
    };
  };
  // What the server answers while its lines are still held.
  proc.hold = (obj) => held.push(JSON.stringify(obj));
  return proc;
}

await test("a carrier's hold is committed, or its server never speaks", async () => {
  // Found in the real agent log: LocalProc answered in 91ms, DaemonProc answered
  // "initialize timed out after 15000ms" on a server that had replied at once — its
  // answer sat in the daemon's hold because nothing called commit(feed).
  const proc = fakeProc();
  let committed = false;
  proc.start = async (opts) => {
    proc.started = opts;
    proc.starts = (proc.starts || 0) + 1;
    return { lines: [], after: [], missed: 0, release() {}, commit() { committed = true; } };
  };
  const adapter = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc, transport: "app-server" });
  adapter.start("default", null).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(committed, true, "without commit the daemon's hold never releases");
  assert.ok(proc.sent("initialize")[0], "and the handshake goes out");
  adapter.stop();
});

// The answer can be written before the request that asks for it: the caller commits as
// soon as the spawn returns, and only then sends `initialize`. A response with no waiting
// id has to be HELD, not dropped — dropping it is the same silent stall as the undrained
// hold, one layer up.
await test("an answer that arrives before its request is held, not discarded", async () => {
  const proc = fakeProc();
  proc.start = async () => {
    // codex answered `initialize` while the spawn handshake was still running.
    return {
      lines: [], after: [], missed: 0, release() {},
      commit(feed) { feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex/0.154.0" } })); }
    };
  };
  const adapter = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc, transport: "app-server" });
  const ready = adapter.start("default", null);
  await new Promise((r) => setTimeout(r, 30));
  const ts = proc.sent("thread/start")[0];
  assert.ok(ts, "the early answer was kept and used");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { thread: { id: "t-1" } } });
  await ready;
  assert.equal(adapter.activeThreadId, "t-1");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
