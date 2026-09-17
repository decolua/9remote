// The JSON-RPC layer codex's app-server speaks, held apart from the CLI that uses it.
//
// `codex exec --json` prints one-way JSONL and a process is born per turn; the app-server
// keeps one process for the whole chat and answers back, so a turn is a *request* with an
// id rather than a line in the void. Every engine that works this way (codex today, Claude
// when it migrates) needs the same four things — correlate a response to its request, take
// notifications, answer a server-initiated request, and survive a process that dies
// mid-flight — so they live here once.
//
// Run: node agent/test/jsonRpcClient.test.mjs
import assert from "node:assert/strict";
import { JsonRpcClient } from "../features/ai/proc/jsonRpcClient.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// A proc that records what was written and lets a test push lines back, standing in for
// the daemon-backed process without spawning anything.
function fakeProc() {
  const proc = {
    written: [],
    onLine: null,
    onExit: null,
    write(text) { proc.written.push(text); },
    // What the CLI would print.
    emit(obj) { proc.onLine?.(typeof obj === "string" ? obj : JSON.stringify(obj)); },
    exit(info = { code: 0 }) { proc.onExit?.(info); },
    last() { return JSON.parse(proc.written[proc.written.length - 1]); }
  };
  return proc;
}

const setup = (opts) => {
  const proc = fakeProc();
  const rpc = new JsonRpcClient(proc, opts);
  return { proc, rpc };
};

// ── requests and responses ──

await test("a request goes out with an id and resolves on the matching response", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("thread/start", { cwd: "/w" });
  const sent = proc.last();
  assert.equal(sent.method, "thread/start");
  assert.deepEqual(sent.params, { cwd: "/w" });
  assert.equal(sent.jsonrpc, "2.0");
  assert.ok(sent.id !== undefined, "a request without an id can never be resolved");

  proc.emit({ jsonrpc: "2.0", id: sent.id, result: { threadId: "t-1" } });
  assert.deepEqual(await p, { threadId: "t-1" });
});

await test("ids advance, so two requests in flight cannot answer for each other", async () => {
  const { proc, rpc } = setup();
  const a = rpc.request("a", {});
  const b = rpc.request("b", {});
  const [ida, idb] = proc.written.map((w) => JSON.parse(w).id);
  assert.notEqual(ida, idb);

  // Answered out of order — the later one first.
  proc.emit({ jsonrpc: "2.0", id: idb, result: "B" });
  proc.emit({ jsonrpc: "2.0", id: ida, result: "A" });
  assert.equal(await a, "A");
  assert.equal(await b, "B");
});

await test("an error response rejects that request, and only that one", async () => {
  const { proc, rpc } = setup();
  const good = rpc.request("good", {});
  const bad = rpc.request("bad", {});
  const [idGood, idBad] = proc.written.map((w) => JSON.parse(w).id);

  proc.emit({ jsonrpc: "2.0", id: idBad, error: { code: -32600, message: "unknown variant" } });
  proc.emit({ jsonrpc: "2.0", id: idGood, result: "ok" });

  await assert.rejects(() => bad, /unknown variant/);
  assert.equal(await good, "ok");
});

await test("a response for an id nobody is waiting on is dropped, not thrown", async () => {
  const { rpc } = setup();
  const { proc } = setup();
  // A response that arrives after its request already timed out or was cancelled.
  const rpc2 = new JsonRpcClient(proc);
  proc.emit({ jsonrpc: "2.0", id: 999, result: "late" });
  proc.emit({ jsonrpc: "2.0", id: 998, error: { message: "late failure" } });
  assert.ok(rpc && rpc2, "an unmatched response must not take the client down");
});

// Recorded from the real server: `thread/started` and the initialize result land BEFORE
// the notification stream begins, and a turn's response interleaves with its own
// notifications. Anything that assumed "response first, then notifications" stalls.
await test("notifications arriving before and between responses still route", async () => {
  const { proc, rpc } = setup();
  const seen = [];
  rpc.on("item/agentMessage/delta", (p) => seen.push(p.delta));

  proc.emit({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "t-1" } });
  const p = rpc.request("turn/start", {});
  proc.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "a" } });
  proc.emit({ jsonrpc: "2.0", id: proc.last().id, result: { turn: { id: "turn-1" } } });
  proc.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "b" } });

  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(await p, { turn: { id: "turn-1" } });
});

await test("a notification with no handler is ignored, so a newer server cannot crash us", () => {
  const { proc, rpc } = setup();
  rpc.on("item/agentMessage/delta", () => {});
  proc.emit({ jsonrpc: "2.0", method: "some/future/notification", params: { whatever: 1 } });
});

await test("a notify() sends no id and expects no answer", () => {
  const { proc, rpc } = setup();
  rpc.notify("initialized", { ready: true });
  const sent = proc.last();
  assert.equal(sent.method, "initialized");
  assert.equal(sent.id, undefined, "a notification with an id would be answered into nowhere");
});

// ── server-initiated requests ──

await test("a server request reaches its handler and the answer goes back on the same id", () => {
  const { proc, rpc } = setup();
  const seen = [];
  rpc.on("execCommandApproval", (params) => {
    seen.push(params);
    return { decision: "approved" };
  });

  proc.emit({ jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval", params: { callId: "c1" } });
  assert.deepEqual(seen, [{ callId: "c1" }]);
  const answer = proc.last();
  assert.equal(answer.id, "srv-1", "the answer must carry the server's own id");
  assert.deepEqual(answer.result, { decision: "approved" });
});

await test("a handler may answer later, for a gate that waits on the user", async () => {
  const { proc, rpc } = setup();
  rpc.on("execCommandApproval", () => new Promise(() => {}));
  proc.emit({ jsonrpc: "2.0", id: "srv-2", method: "execCommandApproval", params: {} });
  assert.equal(proc.written.length, 0, "no answer until the user gives one");

  // The adapter answers through the client rather than the handler's return value.
  rpc.respond("srv-2", { decision: "denied" });
  assert.deepEqual(proc.last(), { jsonrpc: "2.0", id: "srv-2", result: { decision: "denied" } });
});

await test("a server request with no handler is answered, never left hanging", () => {
  const { proc, rpc } = setup();
  // Silence would leave the CLI blocked on a gate forever and the turn dead.
  proc.emit({ jsonrpc: "2.0", id: "srv-3", method: "somethingWeDoNotKnow", params: {} });
  const answer = proc.last();
  assert.equal(answer.id, "srv-3");
  assert.ok(answer.error, "an unhandled request must be refused, not ignored");
});

// ── the envelope is per-CLI, so the WRITE side is injectable too ──

await test("a client can spell its answers the way its own CLI expects", async () => {
  // The read side was already injectable (extractId/extractMethod). The write side was
  // not: `respond` always wrote a JSON-RPC envelope, which is codex's spelling. Claude
  // answers a gate with `{type:"control_response", response:{request_id, …}}` — a
  // different shape entirely, so migrating it here needs the same seam.
  const proc = fakeProc();
  const rpc = new JsonRpcClient(proc, {
    extractId: (m) => (m.type === "control_request" ? m.request_id : (m.id ?? null)),
    extractMethod: (m) => (m.type === "control_request" ? m.request?.subtype : null),
    encodeResponse: (id, result) => ({ type: "control_response", response: { subtype: "success", request_id: id, response: result } })
  });
  rpc.on("can_use_tool", () => ({ behavior: "allow" }));
  proc.emit({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool" } });

  assert.deepEqual(proc.last(), {
    type: "control_response",
    response: { subtype: "success", request_id: "req-1", response: { behavior: "allow" } }
  });
});

await test("the default encoder is unchanged, so codex keeps its own envelope", () => {
  const { proc, rpc } = setup();
  rpc.respond("srv-9", { ok: true });
  assert.deepEqual(proc.last(), { jsonrpc: "2.0", id: "srv-9", result: { ok: true } });
});

await test("a message that is none of the three kinds is handed on, not dropped", async () => {
  // JSON-RPC has exactly three shapes and this client routed all of them. Claude's stdout
  // is not JSON-RPC: `assistant`, `stream_event`, `result` and `user` are the conversation
  // itself — `extractMethod` answers null for every one of them, so they fell into the
  // "response to something we asked" branch, found no pending id, and were DISCARDED.
  // Migrating Claude onto this client without a fourth seam would lose the whole chat.
  const proc = fakeProc();
  const seen = [];
  const rpc = new JsonRpcClient(proc, {
    extractId: (m) => (m.type === "control_request" ? m.request_id : (m.id ?? null)),
    extractMethod: (m) => (m.type === "control_request" ? m.request?.subtype : null),
    onMessage: (m) => seen.push(m.type)
  });
  proc.emit({ type: "assistant", message: { content: [] } });
  proc.emit({ type: "stream_event", event: {} });
  proc.emit({ type: "result", subtype: "success" });

  assert.deepEqual(seen, ["assistant", "stream_event", "result"], "every record reaches the caller");
});

await test("a real response is still routed, not handed to onMessage", () => {
  // The seam must not swallow the traffic the client exists for.
  const proc = fakeProc();
  const seen = [];
  const rpc = new JsonRpcClient(proc, { onMessage: (m) => seen.push(m.id) });
  const answer = rpc.request("initialize", {});
  proc.emit({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(seen, [], "a response is not a stray message");
  return answer.then((r) => assert.deepEqual(r, { ok: true }));
});

await test("a server request still reaches its handler, not onMessage", () => {
  const proc = fakeProc();
  const seen = [];
  const rpc = new JsonRpcClient(proc, { onMessage: (m) => seen.push(m.method) });
  rpc.on("execCommandApproval", () => ({ decision: "approved" }));
  proc.emit({ jsonrpc: "2.0", id: "s1", method: "execCommandApproval", params: {} });
  assert.deepEqual(seen, [], "a request is answered, not passed on");
  assert.ok(proc.last().result, "and the answer was written");
});

await test("a notification still reaches its handler, not onMessage", () => {
  const proc = fakeProc();
  const seen = [];
  const rpc = new JsonRpcClient(proc, { onMessage: (m) => seen.push(m.method) });
  rpc.on("turn/started", () => {});
  proc.emit({ jsonrpc: "2.0", method: "turn/started", params: {} });
  assert.deepEqual(seen, [], "a known notification is routed to its handler");
});

await test("a notification nobody registered reaches the caller instead of vanishing", () => {
  // The server declares 83 methods and a client registers a handful. Before this, the
  // rest hit `handler?.()` with no handler and were gone — no log, no error, nothing to
  // notice. Claude lost 33 of 39 record shapes that way.
  const proc = fakeProc();
  const seen = [];
  const rpc = new JsonRpcClient(proc, { onMessage: (m) => seen.push(m.method) });
  proc.emit({ jsonrpc: "2.0", method: "turn/diff/updated", params: { diff: "@@" } });
  assert.deepEqual(seen, ["turn/diff/updated"], "an unrouted notification is carried");
});

await test("without the seam, nothing changes for codex", () => {
  const { proc, rpc } = setup();
  assert.doesNotThrow(() => proc.emit({ jsonrpc: "2.0", id: 999, result: {} }));
});

await test("a client can spell its NOTIFICATIONS the way its own CLI expects", async () => {
  // `notify` hardcoded the JSON-RPC envelope, the same shape `respond` used to. Claude's
  // outgoing messages are `{type:"user", …}` and `{type:"control_request", …}` — neither
  // is JSON-RPC, so the write side needs the same seam the read side has.
  const proc = fakeProc();
  const rpc = new JsonRpcClient(proc, {
    encodeNotification: (method, params) => ({ type: method, ...params })
  });
  rpc.notify("user", { message: { role: "user", content: "hi" } });
  assert.deepEqual(proc.last(), { type: "user", message: { role: "user", content: "hi" } });
});

await test("the default notification encoder is unchanged, so codex keeps its own", () => {
  const { proc, rpc } = setup();
  rpc.notify("turn/start", { threadId: "t1" });
  assert.deepEqual(proc.last(), { jsonrpc: "2.0", method: "turn/start", params: { threadId: "t1" } });
});

// ── a process that misbehaves ──

await test("a line that is not JSON is skipped without killing the stream", () => {
  const { proc, rpc } = setup();
  const seen = [];
  rpc.on("ok", (p) => seen.push(p));
  proc.emit("Warning: something on stdout");
  proc.emit("{ this is not json");
  proc.emit({ jsonrpc: "2.0", method: "ok", params: { n: 1 } });
  assert.deepEqual(seen, [{ n: 1 }]);
});

await test("blank lines are skipped", () => {
  const { proc, rpc } = setup();
  const seen = [];
  rpc.on("ok", () => seen.push(1));
  proc.emit("");
  proc.emit("   ");
  proc.emit({ jsonrpc: "2.0", method: "ok", params: {} });
  assert.equal(seen.length, 1);
});

await test("requests in flight are rejected when the process dies mid-turn", async () => {
  const { proc, rpc } = setup();
  const a = rpc.request("turn/start", {});
  const b = rpc.request("thread/start", {});
  proc.exit({ code: 1 });
  await assert.rejects(() => a, /exited|closed/i);
  await assert.rejects(() => b, /exited|closed/i);
});

await test("the exit is reported once, to whoever is listening", () => {
  const { proc, rpc } = setup();
  const exits = [];
  rpc.onExit((info) => exits.push(info));
  proc.exit({ code: 0 });
  proc.exit({ code: 0 });
  assert.equal(exits.length, 1, "a second exit event is not a second exit");
});

await test("a request after the process died fails fast instead of hanging", async () => {
  const { proc, rpc } = setup();
  proc.exit({ code: 1 });
  await assert.rejects(() => rpc.request("late", {}), /exited|closed/i);
});

// ── timeouts ──
//
// A request the server never answers must not hang the caller forever. Measured on the
// real app-server: initialize 25-56ms, thread/start 73-108ms, settings/update and
// feature/list ~30ms — so a 15s window is ~150x the slowest of them.

await test("a request with a timeout rejects when the answer never comes", async () => {
  const { rpc } = setup();
  await assert.rejects(() => rpc.request("thread/start", {}, { timeoutMs: 30 }), /timed out/i);
});

await test("a request with no timeout waits, as it always did", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("slow", {});
  await new Promise((r) => setTimeout(r, 60));
  proc.emit({ jsonrpc: "2.0", id: 1, result: "late but fine" });
  assert.equal(await p, "late but fine");
});

await test("an answer arriving after the timeout is dropped, not resolved twice", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("thread/start", {}, { timeoutMs: 20 });
  const sent = proc.last();
  await assert.rejects(() => p, /timed out/i);
  // The server was only slow. Its answer now lands on an id nobody holds.
  proc.emit({ jsonrpc: "2.0", id: sent.id, result: { thread: { id: "t-late" } } });
  // Nothing to assert on the promise — it already settled. What matters is that the
  // client is still usable and that a SECOND request gets its own id.
  const q = rpc.request("next", {});
  const next = proc.last();
  assert.notEqual(next.id, sent.id);
  proc.emit({ jsonrpc: "2.0", id: next.id, result: "ok" });
  assert.equal(await q, "ok");
});

await test("a timed-out request leaves nothing behind", async () => {
  const { rpc } = setup();
  await assert.rejects(() => rpc.request("a", {}, { timeoutMs: 15 }), /timed out/i);
  await assert.rejects(() => rpc.request("b", {}, { timeoutMs: 15 }), /timed out/i);
  // A leak here is invisible until a long-lived chat has accumulated thousands of them.
  assert.equal(rpc._pending.size, 0, "the pending map must not keep dead requests");
});

await test("the process dying beats the timeout, so the error is the real one", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("thread/start", {}, { timeoutMs: 5000 });
  proc.exit({ code: 1 });
  await assert.rejects(() => p, /exited|closed/i, "a dead server must report as dead, not as slow");
});

await test("a timeout does not fire for a request that was answered in time", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("quick", {}, { timeoutMs: 200 });
  proc.emit({ jsonrpc: "2.0", id: proc.last().id, result: "done" });
  assert.equal(await p, "done");
  // Well past the deadline: a timer that was not cleared would now reject into nothing.
  await new Promise((r) => setTimeout(r, 240));
});

// ── turn/start is deliberately NOT in the timeout group ──
//
// Its response is an ACK ("received"), not "finished". A timeout there would mark the
// turn dead while codex keeps running it, and the next prompt would be refused — a
// worse failure than waiting, because the state diverges instead of the call hanging.
await test("a long-running turn is not timed out by the request layer", async () => {
  const { proc, rpc } = setup();
  const p = rpc.request("turn/start", {}, {});   // no timeoutMs — the caller's choice
  await new Promise((r) => setTimeout(r, 80));
  proc.emit({ jsonrpc: "2.0", id: proc.last().id, result: { turn: { id: "turn-1" } } });
  assert.deepEqual(await p, { turn: { id: "turn-1" } });
});

// ── a CLI whose envelope is not JSON-RPC ──
//
// Claude spells both directions its own way: the request nests its payload under
// `request` with an id under `request_id`, and the ANSWER carries that id inside
// `response`, not on the envelope. Neither is correlatable with the JSON-RPC defaults,
// which is the whole reason the two hooks exist.

const claudeSpelling = {
  encodeRequest: (id, method, params) => ({ type: method, request_id: id, request: params }),
  decodeResponse: (m) => ({
    id: m.type === "control_response" ? (m.response?.request_id ?? null) : null,
    error: m.response?.subtype === "error" ? (m.response.error || "request failed") : null,
    result: m.response?.subtype === "error" ? null : m.response?.response
  })
};

await test("a request is written in this CLI's own envelope", async () => {
  const { proc, rpc } = setup(claudeSpelling);
  rpc.request("control_request", { subtype: "rewind_files", user_message_id: "u1" });
  assert.deepEqual(proc.last(), {
    type: "control_request",
    request_id: 1,
    request: { subtype: "rewind_files", user_message_id: "u1" }
  });
});

await test("its answer resolves the request, with the id read from the body", async () => {
  const { proc, rpc } = setup(claudeSpelling);
  const p = rpc.request("control_request", { subtype: "rewind_files", user_message_id: "u1" });
  proc.emit({ type: "control_response", response: { subtype: "success", request_id: proc.last().request_id, response: { canRewind: true } } });
  assert.deepEqual(await p, { canRewind: true });
});

await test("a refused control request rejects with the CLI's own reason", async () => {
  const { proc, rpc } = setup(claudeSpelling);
  const p = rpc.request("control_request", { subtype: "rewind_conversation" });
  proc.emit({ type: "control_response", response: { subtype: "error", request_id: proc.last().request_id, error: "stale target" } });
  await assert.rejects(() => p, /stale target/);
});

// A refusal is about the REQUEST, not the transport: the conversation records that keep
// arriving must still reach the pane, or a rewind that failed would blank the chat.
await test("the conversation still flows through onMessage around a control answer", async () => {
  const seen = [];
  const { proc, rpc } = setup({ ...claudeSpelling, onMessage: (m) => seen.push(m.type) });
  const p = rpc.request("control_request", { subtype: "rewind_files" });
  proc.emit({ type: "assistant", message: { content: [] } });
  proc.emit({ type: "control_response", response: { subtype: "success", request_id: proc.last().request_id, response: {} } });
  await p;
  assert.deepEqual(seen, ["assistant"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
