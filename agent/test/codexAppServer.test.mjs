// The codex app-server session, driven through a stand-in CLI so every case is reachable
// without a model. The shapes below are the real ones, read off a live server
// (`codex app-server generate-ts` writes its own TS bindings; these are those types).
//
// What this buys over `codex exec --json`:
//   • thinking streams. `exec` sends ONE `item.completed reasoning` after the answer;
//     the app-server sends `item/reasoning/summaryTextDelta` as the model produces it.
//   • every command arrives with `commandActions` — the CLI's own read of what the
//     command did — so a read row is named from the live stream instead of from a
//     rollout file read back off disk.
//
// Run: node agent/test/codexAppServer.test.mjs
import assert from "node:assert/strict";
import { CodexAppServer } from "../features/ai/proc/codexAppServer.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

function fakeProc() {
  return {
    written: [],
    onLine: null,
    onExit: null,
    write(t) { this.written.push(t); },
    emit(o) { this.onLine?.(typeof o === "string" ? o : JSON.stringify(o)); },
    exit(i = { code: 0 }) { this.onExit?.(i); },
    last() { return JSON.parse(this.written[this.written.length - 1]); },
    sent(method) { return this.written.map((w) => JSON.parse(w)).filter((m) => m.method === method); }
  };
}

// Drives the handshake the way the real server does, and hands back the pieces.
async function started(opts = {}) {
  const proc = fakeProc();
  const events = [];
  // `mode`/`networkAccess`/`addDirs` are the app's vocabulary; the server session takes
  // the translated settings, which is what codexSettings.js is for.
  const { mode, networkAccess, addDirs, ...rest } = opts;
  const server = new CodexAppServer({ proc, cwd: "/w", onEvent: (e, d) => events.push([e, d]), ...rest });
  if (mode !== undefined || networkAccess !== undefined || addDirs !== undefined) {
    server.permissionMode = mode || "default";
    Object.assign(server.settings, server.applyOptions({ mode: mode || "default", networkAccess, addDirs }));
  }
  const ready = server.start();

  const init = proc.last();
  assert.equal(init.method, "initialize");
  proc.emit({ jsonrpc: "2.0", id: init.id, result: { userAgent: "codex/0.154.0" } });

  await Promise.resolve();
  const ts = proc.last();
  assert.equal(ts.method, "thread/start");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { thread: { id: "t-1" } } });

  await ready;
  return { proc, server, events, of: (n) => events.filter(([e]) => e === n).map(([, d]) => d) };
}

// One delta of the model's reasoning, exactly as the server spells it.
const thinking = (delta, itemId = "rs_1") => ({
  jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta",
  params: { threadId: "t-1", turnId: "turn-1", itemId, delta, summaryIndex: 0 }
});
const saying = (delta, itemId = "msg_1") => ({
  jsonrpc: "2.0", method: "item/agentMessage/delta",
  params: { threadId: "t-1", turnId: "turn-1", itemId, delta }
});
// A command item, with the action the CLI parsed out of it.
const command = (over = {}) => ({
  type: "commandExecution", id: "call_1", command: "/bin/bash -lc 'cat a.txt'", cwd: "/w",
  processId: null, source: "agent", status: "inProgress",
  commandActions: [{ type: "read", command: "cat a.txt", name: "a.txt", path: "a.txt" }],
  aggregatedOutput: null, exitCode: null, ...over
});
const itemStarted = (item) => ({
  jsonrpc: "2.0", method: "item/started", params: { item, threadId: "t-1", turnId: "turn-1", startedAtMs: 1 }
});
const itemCompleted = (item) => ({
  jsonrpc: "2.0", method: "item/completed", params: { item, threadId: "t-1", turnId: "turn-1", completedAtMs: 2 }
});

// ── handshake ──

await test("start negotiates, opens a thread, and reports the id it got", async () => {
  const { server, proc } = await started();
  assert.equal(server.threadId, "t-1");
  const init = proc.written.map((w) => JSON.parse(w))[0];
  assert.ok(init.params.clientInfo?.name, "the server wants a client name");
  // Nothing is answered before initialize: the server rejects it (probed: -32600).
  assert.ok(proc.written.map((w) => JSON.parse(w)).findIndex((m) => m.method === "thread/start")
    > proc.written.map((w) => JSON.parse(w)).findIndex((m) => m.method === "initialize"));
});

await test("the sandbox and approval policy reach thread/start", async () => {
  const { proc } = await started({ mode: "readOnly", model: "gpt-5.6-luna" });
  const ts = proc.sent("thread/start")[0];
  // The server's own shape, not the exec path's `-s read-only`: a policy OBJECT, whose
  // variant the CLI validates (an unknown one is -32600).
  assert.equal(ts.params.sandboxPolicy?.type, "readOnly");
  assert.equal(ts.params.approvalPolicy, "untrusted", "a narrow mode keeps the gate");
  assert.equal(ts.params.model, "gpt-5.6-luna");
  assert.equal(ts.params.cwd, "/w");
});

await test("effort and personality ride the thread's own params", async () => {
  // Not `config`: probed on the real server, an effort put there did not take. The
  // thread carries `personality` and the collaboration settings carry the effort.
  const { proc } = await started({ effort: "xhigh", personality: "pragmatic" });
  const ts = proc.sent("thread/start")[0];
  assert.equal(ts.params.personality, "pragmatic");
  assert.equal(ts.params.collaborationMode?.settings?.reasoning_effort, "xhigh");
});

// ── turns ──

// `/review` is a COMMAND of this server, not prose. Sent as a prompt it merely asks the
// model to review something ("Không có gì để review" on a clean tree); the server's own
// `review/start` runs the review, which is what the TUI's /review does — measured, it
// emits enteredReviewMode -> command -> exitedReviewMode.
await test("/review calls review/start instead of asking the model to do one", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("/review");
  const rv = proc.sent("review/start")[0];
  assert.ok(rv, "the review RPC went out");
  assert.equal(rv.params.threadId, "t-1");
  assert.deepEqual(rv.params.target, { type: "uncommittedChanges" }, "the target the TUI reviews");
  assert.equal(proc.sent("turn/start").length, 0, "and it is not ALSO sent as a prompt");
  proc.emit({ jsonrpc: "2.0", id: rv.id, result: { turn: { id: "turn-r" }, reviewThreadId: "t-1" } });
  await p;
});

await test("a prompt that merely starts with /review is still a prompt", async () => {
  // Only the bare command routes; "/review the parser" is prose by any reading.
  const { proc, server } = await started();
  const p = server.sendPrompt("/review the parser");
  assert.equal(proc.sent("review/start").length, 0);
  const ts = proc.sent("turn/start")[0];
  assert.ok(ts, "it went out as a turn");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-2" } } });
  await p;
});

await test("a prompt is a turn/start carrying the text as a UserInput", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("hello");
  const ts = proc.sent("turn/start")[0];
  assert.equal(ts.params.threadId, "t-1");
  assert.deepEqual(ts.params.input, [{ type: "text", text: "hello", text_elements: [] }]);

  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
  assert.equal(server.isTurnRunning, true);
});

await test("a second prompt while one is running is refused, not queued silently", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("first");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;
  await assert.rejects(() => server.sendPrompt("second"), /already running/i);
});

await test("turn/completed ends the turn", async () => {
  const { proc, server, of } = await started();
  const p = server.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;

  proc.emit({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "t-1", turn: { id: "turn-1", status: "completed" } }
  });
  assert.equal(server.isTurnRunning, false);
  assert.equal(of("turn_complete").length, 1);
});

// Token usage is its own notification, not a field on the Turn (checked against the
// server's own generated bindings: Turn carries id/items/status/error/timestamps and
// nothing else). Reading it off the turn would leave the counter at zero forever.
await test("token usage arrives on its own notification and reaches the stats", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", method: "thread/tokenUsage/updated",
    params: {
      threadId: "t-1", turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
        last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
        modelContextWindow: 200000
      }
    }
  });
  const stats = of("stats").pop();
  assert.equal(stats.inputTokens, 100, "the window's fill is the turn's own input, not the session total");
  assert.equal(stats.cachedTokens, 80);
  assert.equal(stats.outputTokens, 20);
});

// ── thinking, the reason this transport exists ──

await test("thinking streams: one event per delta, in order", async () => {
  const { proc, of } = await started();
  for (const d of ["Simple", " arithmetic", " question", "."]) proc.emit(thinking(d));
  assert.deepEqual(of("thinking").map((d) => d.text), ["Simple", " arithmetic", " question", "."]);
});

await test("the same reasoning item is not restated when it completes", async () => {
  // `item/completed` carries the whole summary. Sending it too would double every
  // thought — once streamed, once whole.
  const { proc, of } = await started();
  proc.emit(thinking("Simple "));
  proc.emit(thinking("math"));
  proc.emit(itemCompleted({ type: "reasoning", id: "rs_1", summary: ["Simple math"], content: [] }));
  assert.deepEqual(of("thinking").map((d) => d.text), ["Simple ", "math"]);
});

await test("a reasoning item with content deltas instead of a summary still streams", () => {
  // Two spellings on the wire: summaryTextDelta (the default) and textDelta.
  const proc = fakeProc();
  const events = [];
  const server = new CodexAppServer({ proc, cwd: "/w", onEvent: (e, d) => events.push([e, d]) });

  proc.emit({
    jsonrpc: "2.0", method: "item/reasoning/textDelta",
    params: { threadId: "t-1", turnId: "turn-1", itemId: "rs_1", delta: "raw thought", contentIndex: 0 }
  });
  assert.deepEqual(events.map(([, d]) => d.text), ["raw thought"]);
});

await test("reasoning that arrives before the turn response is not lost", async () => {
  const { proc, server, of } = await started();
  const p = server.sendPrompt("hi");
  // Recorded order: the model starts thinking while turn/start is still in flight.
  proc.emit(thinking("first"));
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;
  assert.deepEqual(of("thinking").map((d) => d.text), ["first"]);
});

await test("answer text streams too", async () => {
  const { proc, of } = await started();
  for (const d of ["a", ".txt", " —", " 1"]) proc.emit(saying(d));
  assert.deepEqual(of("delta").map((d) => d.text), ["a", ".txt", " —", " 1"]);
});

// ── tools, named by the CLI itself ──

await test("a command item becomes a tool card named from commandActions", async () => {
  const { proc, of } = await started();
  proc.emit(itemStarted(command()));
  const [start] = of("tool_start");
  assert.equal(start.id, "call_1");
  assert.equal(start.name, "read");
  assert.equal(start.input.command, "cat a.txt", "the action's command is the unwrapped one");
  assert.equal(start.input.path, "a.txt");
  assert.equal(start.status, "running");
});

await test("each command action maps to its own name", async () => {
  const names = {};
  for (const [action, expected] of [
    [{ type: "read", command: "cat a", name: "a", path: "a" }, "read"],
    [{ type: "listFiles", command: "ls", path: null }, "list_files"],
    [{ type: "search", command: "rg x", query: "x", path: "." }, "search"],
    [{ type: "unknown", command: "npm test" }, "command"]
  ]) {
    const { proc, of } = await started();
    proc.emit(itemStarted(command({ commandActions: [action] })));
    names[expected] = of("tool_start")[0].name;
  }
  assert.deepEqual(names, { read: "read", list_files: "list_files", search: "search", command: "command" });
});

await test("several actions in one command keep every command line", async () => {
  const { proc, of } = await started();
  proc.emit(itemStarted(command({
    commandActions: [
      { type: "read", command: "sed -n '1,20p' a.js", name: "a.js", path: "a.js" },
      { type: "read", command: "sed -n '1,20p' b.js", name: "b.js", path: "b.js" }
    ]
  })));
  assert.equal(of("tool_start")[0].input.command, "sed -n '1,20p' a.js; sed -n '1,20p' b.js");
});

await test("no commandActions at all leaves the row a plain command", async () => {
  const { proc, of } = await started();
  proc.emit(itemStarted(command({ commandActions: [] })));
  assert.equal(of("tool_start")[0].name, "command");
});

await test("the completed item closes the card with its output", async () => {
  const { proc, of } = await started();
  proc.emit(itemStarted(command()));
  proc.emit(itemCompleted(command({ status: "completed", aggregatedOutput: "hi\n", exitCode: 0 })));
  const [result] = of("tool_result");
  assert.equal(result.id, "call_1");
  assert.equal(result.output, "hi\n");
  assert.equal(result.status, "done");
});

await test("a non-zero exit is a failure, whatever the status says", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted(command({ status: "completed", aggregatedOutput: "boom", exitCode: 2 })));
  const [result] = of("tool_result");
  assert.equal(result.status, "error");
  assert.match(result.error, /exit 2/);
});

await test("a declined command reports as failed, not silently done", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted(command({ status: "declined", aggregatedOutput: null, exitCode: null })));
  assert.equal(of("tool_result")[0].status, "error");
});

await test("a file change draws its diff", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted({
    type: "fileChange", id: "fc_1", status: "completed",
    changes: [{ path: "/w/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-x\n+y\n" }]
  }));
  const [diff] = of("diff");
  assert.equal(diff.file, "/w/a.txt");
  assert.match(diff.patch, /\+y/);
});

// ── the stream is one thread's, and only one ──

await test("notifications for another thread are ignored", async () => {
  const { proc, of } = await started();
  proc.emit({ ...thinking("other chat"), params: { ...thinking("other chat").params, threadId: "t-OTHER" } });
  proc.emit({ ...saying("other answer"), params: { ...saying("other answer").params, threadId: "t-OTHER" } });
  assert.deepEqual(of("thinking"), []);
  assert.deepEqual(of("delta"), []);
});

await test("an unknown notification is ignored rather than fatal", async () => {
  const { proc } = await started();
  proc.emit({ jsonrpc: "2.0", method: "something/new", params: { threadId: "t-1" } });
  proc.emit({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: {} });
});

// ── approvals: a gate must never open itself ──

await test("an exec approval is surfaced to the user and left unanswered until they choose", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval",
    params: { conversationId: "t-1", callId: "call_1", approvalId: null, command: ["/bin/bash", "-lc", "rm -rf /"], cwd: "/w", reason: null, parsedCmd: [] }
  });
  const [req] = of("permission_request");
  assert.equal(req.requestId, "srv-1");
  assert.match(req.input.command, /rm -rf/);
  // Nothing written back: the CLI is blocked on the user, and an auto-answer here
  // would be the app approving a destructive command on the user's behalf.
  assert.equal(proc.sent("").length, 0);
  assert.ok(!proc.written.some((w) => JSON.parse(w).id === "srv-1"), "the gate stays shut");
});

await test("answering the gate sends the decision on the server's own id", async () => {
  const { proc, server } = await started();
  proc.emit({ jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  server.resolvePermission("srv-1", "allow");
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.equal(answer.id, "srv-1");
  assert.ok(JSON.stringify(answer.result).includes("accept"), `expected an approval decision, got ${JSON.stringify(answer.result)}`);
});

await test("a denial says so", async () => {
  const { proc, server } = await started();
  proc.emit({ jsonrpc: "2.0", id: "srv-2", method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  server.resolvePermission("srv-2", "deny", "not that");
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.ok(JSON.stringify(answer.result).includes("decline"), `expected a denial, got ${JSON.stringify(answer.result)}`);
});

await test("an answer goes back with the id TYPE the request arrived with", async () => {
  // The server's `RequestId` is `string | number` and it NUMBERS its own requests. A
  // client's card is keyed by the string form (that is what travels on the wire), so
  // answering with the string is the easy mistake — and it is fatal. Measured on the real
  // server, one gate, only the answer's id type differing: answered as `"0"`, no further
  // records and no `turn/completed` ever arrived (the turn hung); answered as `0`, the
  // server sent `serverRequest/resolved` and `turn/completed` and ran the command.
  const { proc, server, of } = await started();
  proc.emit({ jsonrpc: "2.0", id: 7, method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  const [req] = of("permission_request");
  assert.equal(req.requestId, "7", "the card is keyed by the string form, as the wire has it");
  assert.equal(server.resolvePermission("7", "allow"), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.strictEqual(answer.id, 7, "and the answer carries the NUMBER back");
});

await test("a string request id is answered as a string", async () => {
  // The other half: ids this host mints (a client-issued request) are strings and must
  // stay strings. Coercing everything to a number would break exactly these.
  const { proc, server } = await started();
  proc.emit({ jsonrpc: "2.0", id: "srv-9", method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  server.resolvePermission("srv-9", "allow");
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.strictEqual(answer.id, "srv-9");
});

await test("a user-input gate is answered on the raw id too", async () => {
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: 12, method: "item/tool/requestUserInput",
    params: { threadId: "t-1", questions: [{ id: "q1", header: "Pick", question: "Which?", options: [{ label: "A" }] }] }
  });
  assert.equal(server.resolveQuestion("12", { "Which?": "A" }), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.strictEqual(answer.id, 12);
});

await test("the server's own resolved record does not eat the gate we are still holding", async () => {
  // The server emits `serverRequest/resolved` for EVERY gate — its own answer included —
  // and it arrives BEFORE the answer write is flushed. Clearing the map there too made the
  // retry check report "no longer waiting" over an answer that had just been accepted.
  const { proc, server, of } = await started();
  proc.emit({ jsonrpc: "2.0", id: 21, method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  proc.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "t-1", requestId: 21 } });
  const [res] = of("permission_resolved");
  assert.equal(res.requestId, "21", "the card is told to go");
  assert.equal(res.behavior, "dismissed", "and not as if this app had allowed it");
  // Still answerable: the resolution is the CLI's statement, not our answer.
  assert.equal(server.resolvePermission("21", "allow"), true);
  assert.strictEqual(JSON.parse(proc.written[proc.written.length - 1]).id, 21);
});

await test("a resolved record for a request we already answered says nothing twice", async () => {
  const { proc, server, of } = await started();
  proc.emit({ jsonrpc: "2.0", id: 22, method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  server.resolvePermission("22", "allow");
  proc.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "t-1", requestId: 22 } });
  assert.equal(of("permission_resolved").length, 0, "one gate, one resolution");
});

await test("answering a gate twice is refused, so a stray answer cannot land", async () => {
  const { proc, server } = await started();
  proc.emit({ jsonrpc: "2.0", id: "srv-3", method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  assert.equal(server.resolvePermission("srv-3", "allow"), true);
  assert.equal(server.resolvePermission("srv-3", "allow"), false, "the CLI is no longer waiting on that id");
});

await test("a user-input gate becomes the question card the app already renders", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "srv-4", method: "item/tool/requestUserInput",
    params: { threadId: "t-1", turnId: "turn-1", itemId: "i1", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "q1", header: "Pick", question: "Which one?", options: [{ label: "A", description: "" }] }] }
  });
  // Through `permission_request`, NOT its own event name: the card lives on the gate door
  // (see AiPaneView), and an event nobody listens for is a question nobody ever sees.
  const [q] = of("permission_request");
  assert.equal(q.requestId, "srv-4");
  assert.equal(q.tool, "AskUserQuestion");
  assert.equal(q.input.questions[0].question, "Which one?");
});

// ── resume, interrupt, and a process that dies ──

await test("resuming reuses the thread instead of starting a new one", async () => {
  const proc = fakeProc();
  const server = new CodexAppServer({ proc, cwd: "/w", onEvent: () => {}, threadId: "t-old" });
  const ready = server.start();
  proc.emit({ jsonrpc: "2.0", id: proc.last().id, result: {} });
  await Promise.resolve();
  const rr = proc.last();
  assert.equal(rr.method, "thread/resume");
  assert.equal(rr.params.threadId, "t-old");
  proc.emit({ jsonrpc: "2.0", id: rr.id, result: { thread: { id: "t-old" } } });
  await ready;
  assert.equal(server.threadId, "t-old");
  assert.equal(proc.sent("thread/start").length, 0);
});

await test("interrupt asks the server to stop the running turn", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;
  assert.equal(server.interrupt(), true);
  const it = proc.sent("turn/interrupt")[0];
  assert.equal(it.params.threadId, "t-1");
  // BOTH ids, because the server's `TurnInterruptParams` is `{ threadId, turnId }` — the
  // turn id is not optional. Asserting only the thread is what let Stop look like a no-op:
  // the request went out, the server refused it for the missing field, and the `.catch`
  // swallowed the refusal while the CLI kept answering.
  assert.equal(it.params.turnId, "turn-1", "the turn id is required, not decoration");
});

await test("interrupt refuses when no turn is open, instead of sending a doomed request", async () => {
  // A thread with nothing running has no turn to interrupt. Sending anyway gets a refusal
  // the caller reads as success, which is how `AiSession.stop` came to clear the pane's
  // turn flag over a CLI that never heard anything.
  const { proc, server } = await started();
  assert.equal(server.interrupt(), false);
  assert.equal(proc.sent("turn/interrupt").length, 0, "nothing is sent for a turn that does not exist");
});

await test("the interrupt's landing is reported to its holder, not the pane", async () => {
  // The adapter's running flag only ever cleared on `turn_complete`/`error`. Swallowing
  // the echo (rightly) took those away from the pane — and wrongly took the flag's only
  // release with them, so every prompt after an Esc was refused forever. The landing now
  // has its own door: `onInterruptSettled`, internal, fired exactly once.
  const settled = [];
  const { proc, server, of } = await started({ onInterruptSettled: () => settled.push(true) });
  const p = server.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;

  assert.equal(server.interrupting, false, "nothing is in flight before a stop");
  assert.equal(server.interrupt(), true);
  assert.equal(server.interrupting, true, "the window is open while the echo is out");
  proc.emit({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "t-1", turn: { id: "turn-1", status: "interrupted" } }
  });
  assert.equal(settled.length, 1, "the holder hears the landing");
  assert.equal(server.interrupting, false, "the window closed with the echo");
  assert.equal(of("turn_complete").length, 0, "the pane does not hear it twice");
});

await test("the server's own echo of our interrupt is swallowed", async () => {
  // The session emits `stopped` the moment turn/interrupt goes out. The server then
  // completes the interrupted turn on its own — a SECOND ending for the same turn.
  // Let through after a queued prompt had started, it stamped that newer turn's span
  // ("Worked for 0s") and killed its running flag. The echo must be consumed silently;
  // the NEXT turn's completion must still announce itself.
  const { proc, server, of } = await started();
  const p = server.sendPrompt("hi");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[0].id, result: { turn: { id: "turn-1" } } });
  await p;
  assert.equal(server.interrupt(), true);
  proc.emit({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "t-1", turn: { id: "turn-1", status: "interrupted" } }
  });
  assert.equal(of("turn_complete").length, 0, "the echo draws nothing");
  assert.equal(server.isTurnRunning, false, "state is still consumed");
  assert.equal(server.turnId, null, "the turn id is released for the next turn");

  // The queued prompt goes in — the echo is gone, this one must end normally.
  const p2 = server.sendPrompt("next");
  proc.emit({ jsonrpc: "2.0", id: proc.sent("turn/start")[1].id, result: { turn: { id: "turn-2" } } });
  await p2;
  proc.emit({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "t-1", turn: { id: "turn-2", status: "completed" } }
  });
  assert.equal(of("turn_complete").length, 1, "the next turn's completion still lands");
});

await test("a process that dies mid-turn ends the turn instead of hanging it", async () => {
  const { proc, server, of } = await started();
  proc.exit({ code: 1 });
  assert.equal(server.isTurnRunning, false);
  assert.equal(of("turn_complete").length, 1, "the pane must not spin forever");
  assert.match(of("error")[0].message, /exited|closed/i);
});

await test("stop() closes the session and refuses later prompts", async () => {
  const { server } = await started();
  await server.stop();
  await assert.rejects(() => server.sendPrompt("after"), /closed|exited/i);
});

// ── settings: the options exec took as argv ──
//
// The app-server is one process per chat, so an option is a field on a request instead
// of a flag on the next spawn. These pin the ones probed against the real server.

await test("initialize declares the experimental capability the settings API needs", async () => {
  // Without it `thread/settings/update` and `collaborationMode/list` answer -32600
  // "requires experimentalApi capability" — probed on the installed binary.
  const { proc } = await started();
  const init = proc.written.map((w) => JSON.parse(w)).find((m) => m.method === "initialize");
  assert.equal(init.params.capabilities?.experimentalApi, true);
});

await test("the sandbox policy reaches thread/start in the server's own shape", async () => {
  // Probed: an unknown variant is rejected with -32600, so the object shape matters.
  const { proc } = await started({ mode: "default", networkAccess: true, addDirs: ["/tmp/extra"] });
  const ts = proc.sent("thread/start")[0];
  assert.equal(ts.params.sandboxPolicy?.type, "workspaceWrite");
  assert.equal(ts.params.sandboxPolicy?.networkAccess, true);
  assert.deepEqual(ts.params.sandboxPolicy?.writableRoots, ["/tmp/extra"]);
});

await test("updateSettings reaches a live thread, which thread/start alone cannot do", async () => {
  const { proc, server } = await started();
  const done = server.updateSettings({ effort: "xhigh", personality: "pragmatic" });
  const up = proc.sent("thread/settings/update")[0];
  assert.equal(up.params.threadId, "t-1");
  assert.equal(up.params.effort, "xhigh");
  assert.equal(up.params.personality, "pragmatic");
  proc.emit({ jsonrpc: "2.0", id: up.id, result: {} });
  assert.equal(await done, true);
});

await test("switching to plan mid-chat goes through collaborationMode", async () => {
  const { proc, server } = await started();
  const done = server.updateSettings({ collaborationMode: { mode: "plan", settings: { model: "", reasoning_effort: "high", developer_instructions: null } } });
  const up = proc.sent("thread/settings/update")[0];
  assert.equal(up.params.collaborationMode.mode, "plan");
  assert.equal(up.params.collaborationMode.settings.reasoning_effort, "high");
  proc.emit({ jsonrpc: "2.0", id: up.id, result: {} });
  await done;
});

await test("a turn carries the settings too, so a mode change lands even if update is refused", async () => {
  const { proc, server } = await started();
  server.settings = { sandboxPolicy: { type: "readOnly", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, approvalPolicy: "untrusted" };
  const p = server.sendPrompt("hi");
  const ts = proc.sent("turn/start")[0];
  assert.equal(ts.params.sandboxPolicy?.type, "readOnly");
  assert.equal(ts.params.approvalPolicy, "untrusted");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
});

await test("updateSettings before a thread exists is queued, not dropped", async () => {
  // A mode picked while the handshake is still in flight must not be lost — it would
  // silently run the turn at the old policy.
  const proc = fakeProc();
  const server = new CodexAppServer({ proc, cwd: "/w", onEvent: () => {} });
  assert.equal(await server.updateSettings({ effort: "high" }), false);
  assert.equal(proc.sent("thread/settings/update").length, 0, "no thread yet, nothing to send");
  assert.equal(server.pendingSettings.effort, "high", "the setting is held for the handshake");
});

// ── images ──

await test("an attached image rides the turn as a localImage input", async () => {
  // Verified against the real server: a localImage turn had the model describe the
  // picture. The exec path spelled this `--image=<path>`.
  const { proc, server } = await started();
  const p = server.sendPrompt("what is this?", [{ path: "/tmp/shot.png", kind: "image" }]);
  const ts = proc.sent("turn/start")[0];
  assert.deepEqual(ts.params.input, [
    { type: "text", text: "what is this?", text_elements: [] },
    { type: "localImage", path: "/tmp/shot.png" }
  ]);
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
});

await test("a turn with no text but an image is still a turn", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("", [{ path: "/tmp/shot.png", kind: "image" }]);
  const ts = proc.sent("turn/start")[0];
  assert.equal(ts.params.input.length, 1);
  assert.equal(ts.params.input[0].type, "localImage");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
});

await test("a non-image attachment is named in the text, since the server takes no file input", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("read this", [{ path: "/tmp/notes.txt", kind: "file" }]);
  const ts = proc.sent("turn/start")[0];
  assert.ok(ts.params.input.every((i) => i.type !== "file"), "there is no file input type");
  assert.match(ts.params.input[0].text, /notes\.txt/);
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
});

// ── timeouts, by request kind ──

await test("the handshake carries a timeout, so a dead server cannot hang the chat", async () => {
  // Measured against the real server: initialize answers in 25-56ms, thread/start in
  // 73-108ms. The window is ~150x the slowest, which leaves room for a loaded machine
  // and still fails fast when the process is gone.
  const proc = fakeProc();
  const server = new CodexAppServer({ proc, cwd: "/w", onEvent: () => {} });
  const p = server.start();
  await Promise.resolve();
  const init = proc.sent("initialize")[0];
  assert.equal(init.method, "initialize");
  // Never answered — the client must give up rather than wait forever.
  await assert.rejects(() => p, /timed out/i, "an unanswered handshake must fail");
});

await test("a settings change carries a timeout too", async () => {
  const { proc, server } = await started();
  const p = server.updateSettings({ effort: "high" });
  await assert.rejects(() => p, /timed out/i);
  assert.ok(proc.sent("thread/settings/update").length);
});

// The one request with NO timeout, and the reason is the whole point of the split:
// its answer is an ack ("received"), not "finished". Timing it out would mark the turn
// dead while codex runs it on, and the next prompt would then be refused — the chat
// wedges in a way nobody can see, which is worse than a call that visibly hangs.
await test("a prompt is never timed out by the request layer", async () => {
  const { proc, server } = await started();
  const p = server.sendPrompt("hi");
  const ts = proc.sent("turn/start")[0];
  assert.ok(ts, "the turn went out");
  // Far beyond any handshake window: the turn is still opening.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.isTurnRunning, true, "an unanswered ack must not look like a dead turn");
  proc.emit({ jsonrpc: "2.0", id: ts.id, result: { turn: { id: "turn-1" } } });
  await p;
});

// ── the records nobody wired ──
//
// The server declares 83 notifications and this class wires a handful. Before the seam,
// everything else hit `handler?.()` with no handler and was GONE: no log, no error, no
// missing pixel. The pane re-renders the CLI's own TUI, so a record it cannot draw must
// still arrive — that is what Claude got first (33 of its 39 shapes were being dropped)
// and what these three tests hold codex to.

await test("a notification nobody wired reaches the pane, under its own name", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "skills/changed", params: {} });
  const carried = of("cli_event");
  assert.equal(carried.length, 1, "an unrouted record must not vanish");
  assert.equal(carried[0].type, "skills/changed");
});

await test("a record something already drew is not carried a second time", async () => {
  const { proc, of } = await started();
  // The answer streams as deltas; carrying the whole message after them would show it twice.
  proc.emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "t-1", delta: "hi" } });
  // One per write. Carrying these is how Claude's replay window filled with telemetry.
  proc.emit({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { threadId: "t-1", delta: "x" } });
  assert.equal(of("cli_event").length, 0, "neither belongs in the timeline");
});

await test("a sub-agent item is drawn as a card, not lost", async () => {
  const { proc, events } = await started();
  const item = {
    type: "collabAgentToolCall", id: "ca_1", tool: "spawnAgent", status: "inProgress",
    prompt: "look at the parser", agentsStates: {}
  };
  proc.emit({ jsonrpc: "2.0", method: "item/started", params: { threadId: "t-1", item } });
  proc.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t-1", item: { ...item, status: "completed" } } });
  const starts = events.filter(([e]) => e === "tool_start").map(([, d]) => d);
  // Two events, ONE card: the card is keyed by the item id, and the completion restates
  // the same id — the shape every other branch here already produces (a command does the
  // same, and `appendTool` upserts on the id rather than opening a second row).
  assert.equal(new Set(starts.map((s) => s.id)).size, 1, "one card, however many times it is restated");
  assert.equal(starts[0].status, "running", "and it opens while the agent runs");
  assert.equal(starts[0].name, "spawn_agent", "the registry's spelling, so the card matches");
  assert.equal(starts[0].input.prompt, "look at the parser");
  assert.equal(events.filter(([e]) => e === "tool_result").length, 1, "and it closes once");
});

await test("an item type this class does not draw still reaches the pane", async () => {
  const { proc, of } = await started();
  // `subAgentActivity` is a bare progress beat for an agent (`started`, `interacted`, …)
  // with no card of its own, so it is the honest example of "carried, not drawn".
  const item = { type: "subAgentActivity", id: "sa_1", kind: "interacted", agentThreadId: "t-2", agentPath: "agent-1" };
  proc.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t-1", item } });
  const carried = of("cli_event");
  assert.equal(carried.length, 1, "the pane is a re-render of the CLI, not a summary of it");
  assert.equal(carried[0].type, "subAgentActivity");
  assert.equal(carried[0].record.kind, "interacted");
});

await test("an announcement of a drawn item is not carried early", async () => {
  // `item/started` fires for EVERY item. A record carried on the way in and again on the
  // way out would draw it twice; only the completion is the record.
  const { proc, of } = await started();
  const item = { type: "contextCompaction", id: "cc_1" };
  proc.emit({ jsonrpc: "2.0", method: "item/started", params: { threadId: "t-1", item } });
  assert.equal(of("cli_event").length, 0, "nothing to say yet");
  proc.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t-1", item } });
  assert.equal(of("cli_event").length, 1, "and now there is");
});

await test("an interrupted agent is closed, not left spinning", async () => {
  // `interrupted` is a status of the server's own bindings and it is NOT `completed`:
  // a user who hit Stop had an agent that stopped. Left out of the done set, its row
  // stayed announced and no completion ever followed — a spinner over finished work.
  const { proc, events } = await started();
  const item = {
    type: "collabAgentToolCall", id: "ca_2", tool: "spawnAgent", status: "inProgress",
    prompt: "long job", agentsStates: {}
  };
  proc.emit({ jsonrpc: "2.0", method: "item/started", params: { threadId: "t-1", item } });
  proc.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t-1", item: { ...item, status: "interrupted" } } });
  const [result] = events.filter(([e]) => e === "tool_result").map(([, d]) => d);
  assert.ok(result, "an interrupted agent still closes its row");
  assert.equal(result.status, "error", "and says it did not finish");
});

await test("an agent whose own state says errored is a failure, whatever the item says", async () => {
  // Recorded on a real run: with no credentials the item reads `completed` while
  // `agentsStates` holds the truth (`errored` + the message). Trusting the item painted
  // a green row over an agent that never ran.
  const { proc, events } = await started();
  const item = {
    type: "collabAgentToolCall", id: "ca_3", tool: "wait", status: "completed", prompt: null,
    agentsStates: { "thread-1": { status: "errored", message: "404 No active credentials" } }
  };
  proc.emit({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t-1", item } });
  const [result] = events.filter(([e]) => e === "tool_result").map(([, d]) => d);
  assert.equal(result.status, "error");
  assert.match(result.error, /404 No active credentials/);
});

await test("a notification for another chat does not leak into this one", async () => {
  // The wired handlers all guard on `_mine`; the passthrough must too, or a server
  // holding several threads draws one chat's records inside another's timeline.
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "warning", params: { threadId: "t-OTHER", message: "someone else's" } });
  assert.equal(of("cli_event").length, 0, "another thread's record is not this chat's");
  proc.emit({ jsonrpc: "2.0", method: "warning", params: { threadId: "t-1", message: "ours" } });
  assert.equal(of("cli_event").length, 1, "its own still arrives");
});

await test("an image the agent looked at is a file row, not a raw record", async () => {
  // Found in the rollouts on this machine: 3 `ImageView` items, drawn by nothing. They are
  // reads, and the file card is the row a read already has.
  const { proc, events } = await started();
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "imageView", id: "iv_1", path: "/tmp/shot.png" } }
  });
  const [start] = events.filter(([e]) => e === "tool_start").map(([, d]) => d);
  assert.equal(start.name, "view_image");
  assert.equal(start.input.path, "/tmp/shot.png");
  const [result] = events.filter(([e]) => e === "tool_result").map(([, d]) => d);
  assert.equal(result.status, "done");
  assert.equal(events.filter(([e]) => e === "cli_event").length, 0, "and it is not also a raw record");
});

await test("entering and leaving review draw as the review's own card", async () => {
  const { proc, events } = await started();
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "enteredReviewMode", id: "rv_1", review: "look for missing tests" } }
  });
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "exitedReviewMode", id: "rv_2", review: "look for missing tests" } }
  });
  const names = events.filter(([e]) => e === "tool_start").map(([, d]) => d.name);
  // Under the CLI's OWN names: mapping them onto Claude's plan-mode pair made the pane say
  // "Plan Mode Activated", about the wrong engine, for a code review.
  assert.deepEqual(names, ["enteredReviewMode", "exitedReviewMode"]);
  const [entered] = events.filter(([e]) => e === "tool_start").map(([, d]) => d);
  assert.equal(entered.input.review, "look for missing tests", "and the review is what it says");
});

// ── the gate nobody registered ──
//
// The client refuses an unhandled server request ITSELF (`unhandled server request: …`),
// which is better than hanging the CLI and worse than asking the user: the app answered
// on their behalf, and nothing anywhere said so. Probed against the server's own
// `ServerRequest` union — 10 requests, 5 of which were unregistered.

await test("a request for more permissions is a gate, not an auto-refusal", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "s-grant", method: "item/permissions/requestApproval",
    params: { threadId: "t-1", reason: "needs the network to install", permissions: { network: { enabled: true } } }
  });
  const [gate] = of("permission_request");
  assert.ok(gate, "the user is asked instead of refused");
  assert.equal(gate.requestId, "s-grant");
  assert.equal(gate.tool, "request_permissions");
  assert.match(gate.input.reason, /needs the network/);
  // Nothing was written back: the CLI stays blocked until the user decides.
  assert.equal(proc.sent("item/permissions/requestApproval").length, 0, "no answer on the user's behalf");
});

await test("allowing a permission grant answers with what was granted", async () => {
  // The two response shapes are the server's: a decision (`accept`) for an approval, a
  // granted PROFILE for this one. Sending the wrong one is a refusal it cannot read.
  const { proc, server } = await started();
  const params = { threadId: "t-1", reason: "install deps", permissions: { network: { enabled: true } } };
  proc.emit({ jsonrpc: "2.0", id: "s-grant", method: "item/permissions/requestApproval", params });
  assert.equal(server.resolvePermission("s-grant", "allow"), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.deepEqual(answer.result.permissions, { network: { enabled: true } });
  assert.equal(answer.result.scope, "turn", "for this turn, not the whole session");
});

await test("denying a permission grant grants nothing", async () => {
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "s-grant", method: "item/permissions/requestApproval",
    params: { threadId: "t-1", reason: "install deps", permissions: { network: { enabled: true } } }
  });
  server.resolvePermission("s-grant", "deny");
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.deepEqual(answer.result.permissions, {});
  assert.equal(answer.result.decision, undefined, "not the decision shape — that is the other gate");
});

await test("an ordinary approval still answers with a decision", async () => {
  // The fix above must not change the gate that already worked.
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "s-exec", method: "item/commandExecution/requestApproval",
    params: { threadId: "t-1", command: ["ls"], cwd: "/w" }
  });
  server.resolvePermission("s-exec", "allow");
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.equal(answer.result.decision, "accept");
  assert.equal(answer.result.permissions, undefined);
});

// ── a question the CLI is blocking on ──
//
// The server declares `item/tool/requestUserInput` and this class registered it, but it
// announced the gate on its OWN event name (`question`) — which no client listens for. The
// card is reached through `permission_request`, the door every other gate takes, so a
// question the CLI was waiting on never appeared and the turn sat there forever.

await test("a question reaches the pane through the gate door every card knows", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "q1", method: "item/tool/requestUserInput",
    params: {
      threadId: "t-1", isBlocking: true,
      questions: [{
        id: "q_a", header: "Pick", question: "Which one?", isOther: false, isSecret: false,
        options: [{ label: "A", description: "first" }, { label: "B", description: "second" }]
      }]
    }
  });
  const [gate] = of("permission_request");
  assert.ok(gate, "the pane is told, on the door its question card is on");
  assert.equal(gate.tool, "AskUserQuestion", "the tool name that card switches on");
  assert.equal(gate.requestId, "q1");
  // The questions ride in `input`, which is where AiQuestionCard reads them from.
  assert.equal(gate.input.questions[0].question, "Which one?");
  assert.equal(gate.input.questions[0].options[0].label, "A");
  assert.equal(proc.written.length >= 0 && proc.sent("item/tool/requestUserInput").length, 0,
    "nothing is answered on the user's behalf");
});

await test("an answer is keyed by the question's ID, which is what the server validates", async () => {
  // The card hands back labels keyed by the question TEXT — that is the shape every
  // engine's card produces. This server wants `{<id>: {answers: [...]}}`, and it refuses
  // a reply whose keys it does not recognise.
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "q1", method: "item/tool/requestUserInput",
    params: {
      threadId: "t-1",
      questions: [{ id: "q_a", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }]
    }
  });
  assert.equal(server.resolveQuestion("q1", { "Which one?": "B" }), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.deepEqual(answer.result, { answers: { q_a: { answers: ["B"] } } });
});

await test("an answer for a question nobody asked is not sent", async () => {
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "q1", method: "item/tool/requestUserInput",
    params: { threadId: "t-1", questions: [{ id: "q_a", question: "Which one?", options: [] }] }
  });
  server.resolveQuestion("q1", { "Some other question": "x", "Which one?": "A" });
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.deepEqual(Object.keys(answer.result.answers), ["q_a"], "only the question that was asked");
});

await test("answering a question the CLI already moved past is refused", async () => {
  // Same rule as a permission gate: a stale answer would be a stray response on the pipe
  // and reported success for an answer nobody received.
  const { server } = await started();
  assert.equal(server.resolveQuestion("nobody", { q: "a" }), false);
});

// ── an MCP server asking the user something ──
//
// `elicitation/create` is MCP's way for a server to ask, and it states the ask as a JSON
// Schema rather than a question list. Unregistered here, the client refused it on the
// user's behalf — an MCP tool that needed an answer got a denial nobody was shown.

await test("an elicitation becomes the same question card, from its schema", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "el-1", method: "mcpServer/elicitation/request",
    params: {
      threadId: "t-1", serverName: "node_repl", mode: "form", message: "Pick one",
      requestedSchema: {
        type: "object", required: ["env"],
        properties: {
          env: { type: "string", enum: ["dev", "prod"], title: "Environment" },
          note: { type: "string", description: "Anything to add?" }
        }
      }
    }
  });
  const [gate] = of("permission_request");
  assert.ok(gate, "the user is asked, not refused");
  assert.equal(gate.tool, "AskUserQuestion");
  const [env, note] = gate.input.questions;
  assert.equal(env.question, "Environment", "a titled enum is a question with choices");
  assert.deepEqual(env.options.map((o) => o.label), ["dev", "prod"]);
  assert.equal(env.required, true);
  // A free string has no choices, which is exactly what the card's text box is for.
  assert.equal(note.isOther, true);
  assert.equal(note.options, null);
});

await test("the other enum families read too, including multi-select", async () => {
  // Each of these is a real spelling in the MCP schema: `oneOf` with titles, and the
  // multi-select variants that nest the choices under `items`.
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "el-2", method: "mcpServer/elicitation/request",
    params: {
      threadId: "t-1", serverName: "s", mode: "form", message: "",
      requestedSchema: {
        type: "object",
        properties: {
          one: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
          many: { type: "array", items: { anyOf: [{ const: "x", title: "X" }] } }
        }
      }
    }
  });
  const [gate] = of("permission_request");
  const [one, many] = gate.input.questions;
  assert.deepEqual(one.options.map((o) => o.label), ["Alpha", "Beta"]);
  assert.deepEqual(many.options.map((o) => o.label), ["X"]);
  assert.equal(many.multiSelect, true, "an array property is the toggle list");
});

await test("the elicitation's answer is MCP's own shape, not this server's", async () => {
  // `{action, content}` keyed by the schema's property names — not `{answers: {id: {…}}}`.
  const { proc, server } = await started();
  proc.emit({
    jsonrpc: "2.0", id: "el-3", method: "mcpServer/elicitation/request",
    params: {
      threadId: "t-1", serverName: "s", mode: "form", message: "",
      requestedSchema: { type: "object", properties: { env: { type: "string", enum: ["dev", "prod"], title: "Environment" } } }
    }
  });
  assert.equal(server.resolveQuestion("el-3", { Environment: "prod" }), true);
  const answer = JSON.parse(proc.written[proc.written.length - 1]);
  assert.equal(answer.result.action, "accept");
  assert.deepEqual(answer.result.content, { env: "prod" }, "keyed by the property name");
  assert.equal(answer.result.answers, undefined, "not the other gate's shape");
});

// ── the turn's plan IS the task strip ──
//
// This transport has no `todo_list` item at all — it states the plan as
// `turn/plan/updated`, whole, every time a step moves. Nothing drew it, so the strip
// stayed empty for an entire plan while the CLI was visibly working through one.

await test("a turn plan arrives as the task list the strip renders", async () => {
  const { proc, events } = await started();
  proc.emit({
    jsonrpc: "2.0", method: "turn/plan/updated",
    params: {
      threadId: "t-1", turnId: "turn-1", explanation: "start with the parser",
      plan: [
        { step: "read the parser", status: "completed" },
        { step: "patch it", status: "inProgress" },
        { step: "run the tests", status: "pending" }
      ]
    }
  });
  const [plan] = events.filter(([e]) => e === "tool_start").map(([, d]) => d);
  assert.ok(plan, "the plan reaches the pane");
  // `todo_list` is the tool name the registry maps to the task shape, and the input is
  // exactly what `_parseReplaceAllTodos` reads — so the strip fills by the same road
  // every other engine's checklist takes.
  assert.equal(plan.name, "todo_list");
  assert.equal(plan.input.todos.length, 3);
  assert.equal(plan.input.todos[1].content, "patch it");
});

await test("a plan that states nothing is not a task row", async () => {
  const { proc, events } = await started();
  proc.emit({ jsonrpc: "2.0", method: "turn/plan/updated", params: { threadId: "t-1", turnId: "turn-1", plan: [] } });
  assert.equal(events.filter(([e]) => e === "tool_start").length, 0);
});

// ── a refusal under a narrow sandbox ──
//
// Codex has no structured refusal event on EITHER transport — it says so in prose
// ("I can't create X because this workspace is read-only"). The exec transport has always
// turned that into a card offering the mode that would allow the action; the app-server,
// which is the DEFAULT transport, showed the sentence and no way out of it.

await test("a refusal under a narrow sandbox offers the mode that would allow it", async () => {
  const { proc, events } = await started({ mode: "readOnly" });
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: {
      threadId: "t-1",
      item: {
        type: "agentMessage", id: "m1",
        text: "I can't create that file because this workspace is read-only."
      }
    }
  });
  const [blocked] = events.filter(([e]) => e === "blocked").map(([, d]) => d);
  assert.ok(blocked, "the card that says what to do about it");
  assert.equal(blocked.engine, "codex");
  assert.equal(blocked.escalate.mode, "default", "the first mode that can write");
  assert.equal(blocked.escalate.label, "Default");
  assert.match(blocked.message, /read-only/);
});

await test("an ordinary reply is not read as a refusal", async () => {
  // The pattern needs a refusal VERB beside the reason: a bare "read-only" also appears in
  // a sentence that merely describes a file, and offering escalation for that is noise.
  const { proc, events } = await started({ mode: "readOnly" });
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "agentMessage", id: "m2", text: "a.txt is read-only here, and I read it fine." } }
  });
  assert.equal(events.filter(([e]) => e === "blocked").length, 0, "reading a file is not a refusal");
});

await test("a chat already at full access is offered nothing to escalate to", async () => {
  const { proc, events } = await started({ mode: "fullAccess" });
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "agentMessage", id: "m3", text: "I cannot write outside the workspace." } }
  });
  assert.equal(events.filter(([e]) => e === "blocked").length, 0, "there is no mode above the top");
});

await test("the plan's own status spelling reaches the strip as in_progress", async () => {
  // The strip and the modal switch on `in_progress`; this server says `inProgress`
  // (`TurnPlanStepStatus`), and that row drew as a PENDING dot beside work already
  // under way. Normalized at the parse door, which is the one place both doors read.
  const { parseEngineTaskEvent } = await import("../../web/features/ai/registry.js");
  const parsed = parseEngineTaskEvent("codex", "todo_list", {
    todos: [{ content: "patch it", status: "inProgress" }, { content: "done", status: "completed" }]
  }, "plan-t1", []);
  assert.deepEqual(parsed.todos.map((t) => t.status), ["in_progress", "completed"]);
});

await test("a plan being written grows on screen instead of appearing finished", async () => {
  // `item/plan/delta` is the plan as it is WRITTEN, and the server says its fragments need
  // not even match the completed text. So the card is fed the whole text so far on each
  // delta — a fragment is not a plan — and the completed item replaces it when it lands.
  const { proc, events } = await started();
  const delta = (d) => proc.emit({
    jsonrpc: "2.0", method: "item/plan/delta",
    params: { threadId: "t-1", turnId: "turn-1", itemId: "pl_1", delta: d }
  });
  delta("1. read the parser\n");
  delta("2. patch it\n");
  const plans = events.filter(([e]) => e === "tool_start").map(([, d]) => d.input.plan);
  assert.equal(plans[0], "1. read the parser\n", "the first piece shows at once");
  assert.equal(plans[1], "1. read the parser\n2. patch it\n", "and the next restates the whole plan");
  assert.equal(events.filter(([e]) => e === "tool_start")[0][1].name, "update_plan");
  // The item's own text is the authority: it replaces the preview, not extends it.
  proc.emit({
    jsonrpc: "2.0", method: "item/completed",
    params: { threadId: "t-1", item: { type: "plan", id: "pl_1", text: "the final plan\n" } }
  });
  const last = events.filter(([e]) => e === "tool_start").map(([, d]) => d.input.plan).at(-1);
  assert.equal(last, "the final plan\n");
});


// ── the records the pane was never told about ──
//
// The server declares 83 notifications and this class wired 17. Everything else fell to
// the passthrough, which hands a record to the client under its own name — and the client
// only DRAWS the names it knows. Five families were reaching it as nothing at all, each
// measured on a real server (see the e2e for the two that need one).

await test("a thread rename reaches the pane as the chat's own title", async () => {
  // `conversationTitle` reads the ROLLOUT file, which only ever holds the FIRST prompt —
  // so a thread renamed in the TUI (or by `/rename`) kept its old name everywhere. The
  // server states the new one; nothing was listening.
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "thread/name/updated", params: { threadId: "t-1", threadName: "Fix the parser" } });
  const [init] = of("init");
  assert.equal(init.threadName, "Fix the parser");
  assert.equal(init.threadId, "t-1");
});

await test("a rename with no name does not blank the title we have", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "thread/name/updated", params: { threadId: "t-1", threadName: "Named" } });
  proc.emit({ jsonrpc: "2.0", method: "thread/name/updated", params: { threadId: "t-1" } });
  const inits = of("init");
  assert.equal(inits.length, 1, "a nameless record states nothing, so it says nothing");
});

await test("a gate answered somewhere else closes the card here too", async () => {
  // The server says when a request it was holding is resolved — by another client, or by
  // the TUI. Unread, the card stayed on screen over a CLI that had moved on: the answer
  // reached no handler, and only an F5 cleared it.
  const { proc, server, of } = await started();
  proc.emit({ jsonrpc: "2.0", id: "srv-9", method: "execCommandApproval", params: { callId: "c1", command: ["ls"], cwd: "/w", parsedCmd: [] } });
  assert.equal(of("permission_request").length, 1, "the card is up");
  proc.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "t-1", requestId: "srv-9" } });
  const [done] = of("permission_resolved");
  assert.equal(done.requestId, "srv-9", "and answers for the id the card is keyed by");
  // The map is deliberately NOT cleared here — see the test above: the answer path owns
  // that, and doing it in both places reported a good answer as "no longer waiting".
  assert.equal(server.gates.size, 1);
});

await test("a resolved request nobody asked about is ignored", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "t-1", requestId: "never-seen" } });
  assert.equal(of("permission_resolved").length, 0);
});

// ── a rewind this host did not run: NOT fixable from here ──
//
// `thread/revert` cuts the server's own store and does NOT rewrite the rollout file —
// measured on a real server: 2 turns with 2 prompts in the rollout before the revert, 1
// turn in the store and still 2 prompts in the rollout after it. The session's log is
// built from the rollout, so a rebuild would hand back exactly the turns the user just
// discarded. That is why there is no `conversation_reverted` handler: the correct fix is a
// rewind path that reads `thread/turns/list` instead of the rollout, and half of one is
// worse than none. Pinned so the tempting one is not re-added.

await test("thread/reverted is passed through, not acted on", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "thread/reverted", params: { threadId: "t-1" } });
  // No reset, no rebuild — the pane's log is untouched, and the record travels as itself.
  assert.equal(of("conversation_reset").length, 0);
  assert.equal(of("conversation_reverted").length, 0);
  const [ev] = of("cli_event");
  assert.equal(ev?.type, "thread/reverted");
});

await test("the turn's aggregate diff is routed, not drawn as a second card per file", async () => {
  // The pane keys diffs by FILE. This record is one diff across every file of the turn,
  // so feeding it in would overwrite the per-file cards the fileChange items produce.
  // It is routed (never passed through) and dropped.
  const { proc, events } = await started();
  proc.emit({ jsonrpc: "2.0", method: "turn/diff/updated", params: { threadId: "t-1", turnId: "turn-1", diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n-old\n+new\n" } });
  assert.equal(events.filter(([e]) => e === "diff").length, 0, "no diff card from the aggregate");
  assert.equal(events.filter(([e]) => e === "cli_event").length, 0, "and it is not passed through either");
});

// ── the notices the client already knows how to draw ──
//
// `harnessTasks.noticeFrom` has a codex branch for `warning` / `guardianWarning` /
// `configWarning` / `deprecationNotice` / `model/rerouted` / `error`, matched on the
// notification's OWN name. The passthrough already carries that name, so these need no
// wiring — pinned here because the tempting "fix" is to wrap one in a `system` envelope,
// which reads as more routable and is in fact unreadable (measured: `noticeFrom("system",
// {message:"…"})` is null, while `noticeFrom("warning", …)` is the line).

await test("a codex warning arrives under the name the client's reader matches", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "warning", params: { threadId: "t-1", message: "Stream disconnected - retrying (1/5)" } });
  const [ev] = of("cli_event");
  assert.equal(ev.type, "warning", "the record's own name, not an envelope");
  assert.equal(ev.subtype, "");
  assert.match(ev.record.message, /retrying/);
});

await test("an error keeps its thread id and its retry flag", async () => {
  // `noticeFrom` reads `record.willRetry` to pick the level, and `threadId` is what keeps
  // one chat's failure out of another's pane. Both travel whole, so both must survive.
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "error", params: { threadId: "t-1", turnId: "turn-1", willRetry: true, error: { message: "stream error", codexErrorInfo: null, additionalDetails: null } } });
  const [ev] = of("cli_event");
  assert.equal(ev.type, "error");
  assert.equal(ev.record.willRetry, true);
  assert.equal(ev.record.threadId, "t-1");
});

await test("a model reroute travels with both model names", async () => {
  const { proc, of } = await started();
  proc.emit({ jsonrpc: "2.0", method: "model/rerouted", params: { threadId: "t-1", turnId: "turn-1", fromModel: "gpt-5.6-sol", toModel: "gpt-5.5", reason: "capacity" } });
  const [ev] = of("cli_event");
  assert.equal(ev.type, "model/rerouted");
  assert.equal(ev.record.fromModel, "gpt-5.6-sol");
  assert.equal(ev.record.toModel, "gpt-5.5");
});

// ── hooks: reached, but not DRAWN ──
//
// `hook/started` / `hook/completed` already reach the pane through the passthrough, and
// the pane draws nothing for them: its task model folds only records whose `type` is
// `system` (harnessTasks.applyTaskRecord returns the list unchanged for any other), and
// its notice reader has no branch for either name. A hook row is therefore a CLIENT-side
// job — a reader for codex's `run` shape — not something this file can state its way into.
// Pinned so the host is not "fixed" twice over for a row nobody renders.

await test("a hook arrives whole, under the server's own name", async () => {
  const { proc, of } = await started();
  proc.emit({
    jsonrpc: "2.0", method: "hook/completed",
    params: {
      threadId: "t-1", turnId: null,
      run: { id: "hook-1", eventName: "sessionStart", status: "completed", entries: [{ kind: "info", text: "SessionStart hook ran" }] }
    }
  });
  const [ev] = of("cli_event");
  assert.equal(ev.type, "hook/completed");
  // The params travel as-is, so the run is nested — the shape a client reader would open.
  assert.equal(ev.record.run.id, "hook-1");
  assert.equal(ev.record.run.status, "completed");
  assert.match(ev.record.run.entries[0].text, /SessionStart hook ran/);
});

// ── items the pane drew nothing for ──

await test("a context compaction is one line, not a raw JSON record", async () => {
  // The server declares `contextCompaction` and this class drew 6 of its 19 item types.
  // The seventh fell to the passthrough as `cli_event` with NO subtype — and the client's
  // notice reader answers null for that, so a compaction the TUI prints as "Compacted"
  // showed up as nothing at all.
  const { proc, of } = await started();
  proc.emit(itemCompleted({ type: "contextCompaction", id: "cc_1" }));
  const [ev] = of("cli_event");
  assert.equal(ev.type, "thread/compacted", "the record the pane's compaction line is written for");
  assert.equal(ev.subtype, "compacted");
});

await test("an image the model generated draws as the file it was saved to", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted({ type: "imageGeneration", id: "img_1", status: "completed", revisedPrompt: "a red square", result: "ok", failure: null, savedPath: "/w/out.png" }));
  const [start] = of("tool_start");
  assert.equal(start.name, "image_generation");
  assert.equal(start.input.path, "/w/out.png");
  assert.equal(of("tool_result").length, 1, "and the row closes");
});

await test("a failed image generation says so instead of looking done", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted({ type: "imageGeneration", id: "img_2", status: "failed", revisedPrompt: null, result: "", failure: { message: "content policy" }, savedPath: null }));
  const [res] = of("tool_result");
  assert.equal(res.status, "error");
  assert.match(res.error, /content policy/);
});

await test("a sleep is a row with its duration, not an unknown record", async () => {
  const { proc, of } = await started();
  proc.emit(itemCompleted({ type: "sleep", id: "sleep_1", durationMs: 5000 }));
  const [start] = of("tool_start");
  assert.equal(start.name, "sleep");
  assert.equal(start.input.duration_ms, 5000);
});

// ── the id a gate is keyed by ──

await test("an elicitation is keyed by the same id its answer closes", async () => {
  // Measured, not reasoned about: an elicitation raised with a numeric id and one raised
  // with a string id both land in the map under their STRING form (`"17"` and `"s-1"`),
  // which is what the client's card carries and what it sends back. Pinned because the
  // obvious "fix" — stringifying at the publish site — is a no-op here, and the id that
  // DOES matter is the one the answer goes back on (see the test below).
  const { proc, server, of } = await started();
  proc.emit({
    jsonrpc: "2.0", id: 17, method: "mcpServer/elicitation/request",
    params: { threadId: "t-1", serverName: "srv", message: "Which one?", requestedSchema: { type: "object", properties: { pick: { type: "string", title: "Pick" } } } }
  });
  const [q] = of("permission_request");
  assert.equal(q.requestId, "17", "the id an answer will carry");
  assert.ok(server.gates.has("17"), "and the gate is filed under it");
  assert.equal(server.resolveQuestion("17", { Pick: "A" }), true, "so the answer lands");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
