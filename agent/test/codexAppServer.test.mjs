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
  const [q] = of("question");
  assert.equal(q.requestId, "srv-4");
  assert.equal(q.questions[0].question, "Which one?");
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
  server.interrupt();
  const it = proc.sent("turn/interrupt")[0];
  assert.equal(it.params.threadId, "t-1");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
