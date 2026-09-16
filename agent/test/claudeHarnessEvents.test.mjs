// Every event the Claude harness emits must reach the chat pane.
//
// The pane is a re-render of the TUI, so its vocabulary is supposed to BE the harness's.
// It was not: handleMessage named six record types and let the other thirty-three fall
// through its last `if` into silence — including the whole task model the TUI draws its
// task panel from. The gap was papered over by guessing: a regex over tool output text
// (toolEvent.asyncHandle) and a 120s timer (AiSession.armAsyncWatchdog) stood in for
// signals the CLI was already sending.
//
// The list below is the SDK's own SDKMessage union (checked against
// @anthropic-ai/claude-agent-sdk sdk.d.ts). A record whose type/subtype is on it and
// still reaches the pane is the contract; one that vanishes is the bug.
//
// Run: node agent/test/claudeHarnessEvents.test.mjs
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// A proc that swallows writes and lets a test feed the adapter raw CLI lines.
function fakeProc() {
  return {
    written: [],
    onLine: null,
    onExit: null,
    write(t) { this.written.push(t); },
    emit(o) { this.onLine?.(typeof o === "string" ? o : JSON.stringify(o)); },
    async start() { return { lines: [], after: [], missed: 0, release() {}, commit() {} }; },
    async attach() { return { lines: [], after: [], missed: 0, alive: false, release() {} }; },
    async stop() {}
  };
}

function feeding(lines = []) {
  const events = [];
  const proc = fakeProc();
  const adapter = new ClaudeAdapter({ cwd: "/w", onEvent: (e, d) => events.push([e, d]), proc });
  adapter._reset("default"); // binds onLine, the way start() does before any line arrives
  for (const line of lines) proc.emit(line);
  return { adapter, events, of: (n) => events.filter(([e]) => e === n) };
}

// Recorded verbatim from a live `claude -p --output-format=stream-json` run (2.1.270).
const RECORDED = {
  taskStarted: {
    type: "system", subtype: "task_started", task_id: "bny62e391",
    tool_use_id: "call_lr987rf2", description: "Sleep 15 seconds", is_backgrounded: true,
    task_type: "local_bash", uuid: "u-1", session_id: "s-1"
  },
  taskUpdated: {
    type: "system", subtype: "task_updated", task_id: "bny62e391",
    patch: { status: "killed", end_time: 1789495296193 }, uuid: "u-2", session_id: "s-1"
  },
  taskNotification: {
    type: "system", subtype: "task_notification", task_id: "bny62e391",
    tool_use_id: "call_lr987rf2", status: "stopped",
    output_file: "/tmp/tasks/bny62e391.output", summary: "Sleep 15 seconds",
    uuid: "u-3", session_id: "s-1"
  },
  subagentStarted: {
    type: "system", subtype: "task_started", task_id: "a74d7c02eb53eb979",
    tool_use_id: "call_pj23djzp", description: "Answer 2+2",
    subagent_type: "general-purpose", prompt: "what is 2+2?", uuid: "u-4", session_id: "s-1"
  },
  subagentDone: {
    type: "system", subtype: "task_notification", task_id: "a74d7c02eb53eb979",
    tool_use_id: "call_pj23djzp", status: "completed",
    output_file: "/tmp/tasks/a74.output", summary: 'Agent "Answer 2+2" finished',
    usage: { total_tokens: 1200, tool_uses: 2, duration_ms: 3400 }, uuid: "u-5", session_id: "s-1"
  }
};

// ── the task model, carried rather than translated ──
//
// No `taskStart`-shaped helper sits between the CLI and the pane: the record travels
// whole, under the harness's own type/subtype, so the pane reads the SAME fields the TUI
// reads and nothing has to be updated when the CLI adds one. Translation is what this
// file used to assert, and every field it renamed was a place the two could drift.

const harness = (events, type, subtype) =>
  events.filter(([e, d]) => e === "cli_event" && d.type === type && d.subtype === subtype).map(([, d]) => d.record);

test("a task_started arrives with the harness's own field names", () => {
  const { events } = feeding([RECORDED.taskStarted]);
  const [start] = harness(events, "system", "task_started");
  assert.ok(start, "task_started must reach the pane, not be swallowed");
  assert.equal(start.task_id, "bny62e391");
  assert.equal(start.tool_use_id, "call_lr987rf2");
  assert.equal(start.description, "Sleep 15 seconds");
  assert.equal(start.is_backgrounded, true);
  assert.equal(start.task_type, "local_bash");
});

test("a sub-agent's task_started carries the type that names it", () => {
  const { events } = feeding([RECORDED.subagentStarted]);
  const [start] = harness(events, "system", "task_started");
  assert.equal(start.task_id, "a74d7c02eb53eb979");
  assert.equal(start.subagent_type, "general-purpose");
  assert.equal(start.prompt, "what is 2+2?");
});

test("a task_updated carries the patch the CLI wrote", () => {
  const { events } = feeding([RECORDED.taskUpdated]);
  const [upd] = harness(events, "system", "task_updated");
  assert.ok(upd, "task_updated must reach the pane");
  assert.equal(upd.task_id, "bny62e391");
  assert.equal(upd.patch.status, "killed");
  assert.equal(upd.patch.end_time, 1789495296193);
});

test("a task_notification arrives with its status, output file and usage", () => {
  const { events } = feeding([RECORDED.taskNotification]);
  const [done] = harness(events, "system", "task_notification");
  assert.ok(done, "task_notification must reach the pane");
  assert.equal(done.task_id, "bny62e391");
  assert.equal(done.tool_use_id, "call_lr987rf2");
  assert.equal(done.status, "stopped");
  assert.equal(done.output_file, "/tmp/tasks/bny62e391.output");
});

test("a finished sub-agent reports the usage the CLI gave it", () => {
  const { events } = feeding([RECORDED.subagentDone]);
  const [done] = harness(events, "system", "task_notification");
  assert.equal(done.status, "completed");
  assert.equal(done.summary, 'Agent "Answer 2+2" finished');
  assert.equal(done.usage.total_tokens, 1200);
  assert.equal(done.usage.duration_ms, 3400);
});

test("the live task set arrives as the CLI published it", () => {
  const { events } = feeding([{
    type: "system", subtype: "background_tasks_changed",
    tasks: [{ task_id: "bny62e391", task_type: "local_bash", description: "Sleep 15 seconds" }],
    uuid: "u-6", session_id: "s-1"
  }]);
  const [set] = harness(events, "system", "background_tasks_changed");
  assert.ok(set, "background_tasks_changed must reach the pane");
  assert.equal(set.tasks.length, 1);
  assert.equal(set.tasks[0].task_id, "bny62e391");
  assert.equal(set.tasks[0].task_type, "local_bash");
});

// ── nothing else may vanish either ──

// One realistic record per member of the SDK's SDKMessage union — all 39, so the sweep
// below covers every DOOR a record can come through, not just the `system` one. The
// earlier version of this test only walked `system` subtypes and therefore passed while
// three other doors were still dropping records on the floor.
const SDK_MESSAGES = [
  ["SDKAssistantMessage", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null, uuid: "u", session_id: "s" }],
  ["SDKUserMessage", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, parent_tool_use_id: null, uuid: "u", session_id: "s" }],
  ["SDKUserMessageReplay", { type: "user", message: { role: "user", content: [{ type: "text", text: "replayed" }] }, parent_tool_use_id: null, isReplay: true, uuid: "u", session_id: "s" }],
  ["SDKResultMessage", { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", uuid: "u", session_id: "s" }],
  ["SDKSystemMessage", { type: "system", subtype: "init", uuid: "u", session_id: "s" }],
  ["SDKPartialAssistantMessage", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, uuid: "u", session_id: "s" }],
  ["SDKCompactBoundaryMessage", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" }, uuid: "u", session_id: "s" }],
  ["SDKStatusMessage", { type: "system", subtype: "status", status: "compacting", uuid: "u", session_id: "s" }],
  ["SDKAPIRetryMessage", { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, uuid: "u", session_id: "s" }],
  ["SDKControlRequestProgressMessage", { type: "system", subtype: "control_request_progress", uuid: "u", session_id: "s" }],
  ["SDKModelRefusalFallbackMessage", { type: "system", subtype: "model_refusal_fallback", uuid: "u", session_id: "s" }],
  ["SDKModelRefusalNoFallbackMessage", { type: "system", subtype: "model_refusal_no_fallback", uuid: "u", session_id: "s" }],
  ["SDKLocalCommandOutputMessage", { type: "system", subtype: "local_command_output", uuid: "u", session_id: "s" }],
  ["SDKHookStartedMessage", { type: "system", subtype: "hook_started", uuid: "u", session_id: "s" }],
  ["SDKHookProgressMessage", { type: "system", subtype: "hook_progress", uuid: "u", session_id: "s" }],
  ["SDKHookResponseMessage", { type: "system", subtype: "hook_response", uuid: "u", session_id: "s" }],
  ["SDKPluginInstallMessage", { type: "system", subtype: "plugin_install", uuid: "u", session_id: "s" }],
  ["SDKToolProgressMessage", { type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", elapsed_time_seconds: 3, uuid: "u", session_id: "s" }],
  ["SDKAuthStatusMessage", { type: "auth_status", uuid: "u", session_id: "s" }],
  ["SDKTaskNotificationMessage", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed", output_file: "/tmp/o", summary: "s", uuid: "u", session_id: "s" }],
  ["SDKTaskStartedMessage", { type: "system", subtype: "task_started", task_id: "k1", description: "d", uuid: "u", session_id: "s" }],
  ["SDKTaskUpdatedMessage", { type: "system", subtype: "task_updated", task_id: "k1", patch: { status: "running" }, uuid: "u", session_id: "s" }],
  ["SDKTaskProgressMessage", { type: "system", subtype: "task_progress", task_id: "k1", description: "d", usage: {}, uuid: "u", session_id: "s" }],
  ["SDKBackgroundTasksChangedMessage", { type: "system", subtype: "background_tasks_changed", tasks: [], uuid: "u", session_id: "s" }],
  ["SDKThinkingTokensMessage", { type: "system", subtype: "thinking_tokens", estimated_tokens: 12, estimated_tokens_delta: 3, uuid: "u", session_id: "s" }],
  ["SDKSessionStateChangedMessage", { type: "system", subtype: "session_state_changed", uuid: "u", session_id: "s" }],
  ["SDKWorkerShuttingDownMessage", { type: "system", subtype: "worker_shutting_down", uuid: "u", session_id: "s" }],
  ["SDKCommandsChangedMessage", { type: "system", subtype: "commands_changed", uuid: "u", session_id: "s" }],
  ["SDKNotificationMessage", { type: "system", subtype: "notification", uuid: "u", session_id: "s" }],
  ["SDKFilesPersistedEvent", { type: "system", subtype: "files_persisted", uuid: "u", session_id: "s" }],
  ["SDKToolUseSummaryMessage", { type: "tool_use_summary", uuid: "u", session_id: "s" }],
  ["SDKMemoryRecallMessage", { type: "system", subtype: "memory_recall", uuid: "u", session_id: "s" }],
  ["SDKRateLimitEvent", { type: "rate_limit_event", uuid: "u", session_id: "s" }],
  ["SDKElicitationCompleteMessage", { type: "system", subtype: "elicitation_complete", uuid: "u", session_id: "s" }],
  ["SDKPermissionDeniedMessage", { type: "system", subtype: "permission_denied", uuid: "u", session_id: "s" }],
  ["SDKPromptSuggestionMessage", { type: "prompt_suggestion", uuid: "u", session_id: "s" }],
  ["SDKMirrorErrorMessage", { type: "system", subtype: "mirror_error", uuid: "u", session_id: "s" }],
  ["SDKInformationalMessage", { type: "system", subtype: "informational", uuid: "u", session_id: "s" }],
  ["SDKConversationResetMessage", { type: "conversation_reset", uuid: "u", session_id: "s" }]
];

test("the fixture set is the whole SDK union, not a subset", () => {
  // Guards the guard: a fixture list that quietly shrank would make the sweep below pass
  // by covering less.
  assert.equal(SDK_MESSAGES.length, 39, "the SDK declares 39 message shapes");
  const seen = new Set(SDK_MESSAGES.map(([n]) => n));
  assert.equal(seen.size, 39, "every shape appears once");
});

test("no record of any shape is dropped on the floor", () => {
  const missing = [];
  for (const [name, record] of SDK_MESSAGES) {
    const { events } = feeding([record]);
    if (events.length === 0) missing.push(name);
  }
  assert.deepEqual(missing, [], `records the pane never hears about: ${missing.join(", ")}`);
});

test("a user record the harness wrote itself does not open a bubble", () => {
  // `claude -p` writes its own messages under the user role — the same injected turns
  // isClaudeInjectedTurn exists for in the transcript. Opening a prompt bubble for one
  // leaves the pane with a question nobody asked, and a turn that never closes.
  const { of } = feeding([{
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "<task-notification>x</task-notification>" }] },
    origin: { kind: "task-notification" }, uuid: "u", session_id: "s"
  }]);
  assert.equal(of("user_message").length, 0, "not a prompt the user typed");
  const [ev] = of("cli_event");
  assert.ok(ev, "but it must still arrive");
  assert.equal(ev[1].type, "user");
});

test("a replayed user record arrives too, marked as a replay", () => {
  const { of } = feeding([{
    type: "user", message: { role: "user", content: [{ type: "text", text: "old" }] },
    isReplay: true, uuid: "u", session_id: "s"
  }]);
  const [ev] = of("cli_event");
  assert.ok(ev);
  assert.equal(ev[1].record.isReplay, true);
});

test("a failed result keeps the failure, not just the end of the turn", () => {
  // turn_complete alone says a turn ended; it does not say it ended BADLY. The subtype
  // and the CLI's own error are what the pane needs to say why.
  const { of } = feeding([{
    type: "result", subtype: "error_during_execution", is_error: true,
    result: "Command failed", num_turns: 2, uuid: "u", session_id: "s"
  }]);
  const [done] = of("turn_complete");
  assert.ok(done);
  assert.equal(done[1].isError, true);
  assert.equal(done[1].subtype, "error_during_execution");
  assert.equal(done[1].result, "Command failed");
});

test("a successful result still reports itself as one", () => {
  const { of } = feeding([{ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "u", session_id: "s" }]);
  const [done] = of("turn_complete");
  assert.equal(done[1].isError, false);
  assert.equal(done[1].subtype, "success");
});

test("an assistant record with nothing to render still arrives", () => {
  const { of } = feeding([{ type: "assistant", message: { role: "assistant", content: [] }, uuid: "u", session_id: "s" }]);
  assert.ok(of("cli_event").length > 0, "an empty assistant record must not vanish");
});

test("an unmapped record keeps the harness's own name and payload", () => {
  const { of } = feeding([{
    type: "system", subtype: "api_retry", attempt: 2, max_retries: 5,
    retry_delay_ms: 1000, error_status: 529, uuid: "u-7", session_id: "s-1"
  }]);
  const [ev] = of("cli_event");
  assert.ok(ev, "an unmapped record must still reach the pane");
  assert.equal(ev[1].type, "system");
  assert.equal(ev[1].subtype, "api_retry");
  assert.equal(ev[1].record.attempt, 2);
  assert.equal(ev[1].record.error_status, 529);
});

test("a stream_event is still parsed for its text, not passed through raw", () => {
  const { of } = feeding([{
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    session_id: "s-1"
  }]);
  assert.equal(of("delta")[0][1].text, "hi");
  assert.equal(of("cli_event").length, 0, "a record the pane parses must not ALSO flood through");
});

// ── the guess must not outlive the signal ──

test("the CLI's own task_started and the launch ack agree on the same tool call", () => {
  // Both signals name the same `tool_use_id`. They are kept on one wire because they
  // answer different questions: the ack says this row is not finished, the task record
  // says what the work IS and when it ended.
  const { of, events } = feeding([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call_x", name: "Bash", input: { command: "sleep 9" } }] } },
    { type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "call_x", description: "sleep", is_backgrounded: true },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_x", content: "Command running in background with ID: t-1" }] } }
  ]);
  const [task] = harness(events, "system", "task_started");
  assert.equal(task.tool_use_id, "call_x", "the task names the call that launched it");
  const [result] = of("tool_result");
  assert.equal(result[1].id, "call_x");
  assert.equal(result[1].async, true, "the row still reads as handed off");
});

// ── the RPC client must not answer the CLI's own gate ──

test("a permission gate reaches the adapter, not the RPC client's refusal path", () => {
  // The migration this pins: routing every line through JsonRpcClient made `control_request`
  // look like a server request, so the client answered `unhandled server request` on the
  // spot — refusing every permission prompt before the adapter ever saw it, and the user's
  // Allow button then answered an id the CLI had already been told was unknown.
  const proc = fakeProc();
  const events = [];
  const written = [];
  proc.write = (t) => written.push(t);
  const adapter = new ClaudeAdapter({ cwd: "/w", onEvent: (e, d) => events.push([e, d]), proc });
  adapter._reset("default");

  proc.emit({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });

  assert.equal(events.filter(([e]) => e === "permission_request").length, 1, "the adapter sees the gate");
  assert.equal(adapter.pendingRequests.size, 1, "and holds it for the user's answer");
  assert.equal(written.length, 0, "nothing is written before the user decides");
});

test("answering a gate writes the envelope Claude expects, through the client", () => {
  const proc = fakeProc();
  const written = [];
  proc.write = (t) => written.push(t);
  const adapter = new ClaudeAdapter({ cwd: "/w", onEvent: () => {}, proc });
  adapter._reset("default");
  proc.emit({ type: "control_request", request_id: "req-2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });

  assert.equal(adapter.resolvePermission("req-2", "allow"), true);
  const answer = JSON.parse(written[written.length - 1]);
  assert.equal(answer.type, "control_response");
  assert.equal(answer.response.request_id, "req-2");
  assert.equal(answer.response.subtype, "success");
  assert.deepEqual(answer.response.response.behavior, "allow");
});

test("a prompt and an interrupt go out in the CLI's own shape", () => {
  // Both used to build their envelope by hand; both now go through the RPC client's
  // notification encoder. The BYTES on the wire must not change — a prompt the CLI cannot
  // read is a turn that never starts, and an interrupt it cannot read is a stop button
  // that does nothing.
  const proc = fakeProc();
  const written = [];
  proc.write = (t) => written.push(t);
  const adapter = new ClaudeAdapter({ cwd: "/w", onEvent: () => {}, proc });
  adapter._reset("default");

  adapter.sendPrompt("xin chào", null);
  assert.deepEqual(JSON.parse(written.at(-1)), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "xin chào" }] }
  });

  assert.equal(adapter.interrupt(), true);
  const stop = JSON.parse(written.at(-1));
  assert.equal(stop.type, "control_request");
  assert.equal(stop.request.subtype, "interrupt");
  assert.equal(stop.request.cancel_queued, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
