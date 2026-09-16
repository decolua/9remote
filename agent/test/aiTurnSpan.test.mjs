// The span of the last turn, measured by the host. The pane prints "Worked for …" from
// it, and a client that loads AFTER the turn ended saw neither edge of it — its own clock
// has nothing to measure, which is why the number has to survive on the host, and why it
// is a duration rather than two timestamps (the two clocks sit on different machines).
// Run: node agent/test/aiTurnSpan.test.mjs
import assert from "node:assert/strict";
import { AiSession } from "../features/ai/aiSession.js";
import { publicSession } from "../features/ai/aiSocket.js";
import { getLastOutputAt } from "../features/terminal/statusManager.js";
import { replayWindow } from "../features/ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI turn span tests...");

// A FRESH id per session, not one shared "span". Snapshots are keyed by session id under
// the agent's state dir, so a shared one made every test load the log the test before it
// had written — carried records piled up across runs, and a test that looked at the tail
// of the log was reading another test's leftovers.
let sessionSeq = 0;
const makeSession = () => new AiSession({ id: `span-${Date.now()}-${++sessionSeq}`, engine: "claude", cwd: "/tmp", options: { mock: true } });

await test("a turn stamps its span on the way out, and the host publishes it", () => {
  const s = makeSession();
  s.emitNormalized("user_message", { text: "hi" });
  assert.equal(s.lastTurnMs, 0, "a running turn has no span yet");
  // Backdate the mark rather than asserting an exact difference: the clock is real, so a
  // millisecond can pass between the two reads and an equality assert goes flaky.
  s.turnStartedAt = Date.now() - 4200;
  s.emitNormalized("turn_complete", { stats: {} });
  const span = s.lastTurnMs;
  assert.ok(span >= 4200 && span < 4400, `expected ~4200ms, got ${span}`);
  assert.equal(publicSession(s).lastTurnMs, span);
});

await test("a spawn-time event is not a turn — nothing to measure", () => {
  const s = makeSession();
  s.emitNormalized("init", { model: "claude-sonnet-5" });
  s.emitNormalized("exit", {});
  assert.equal(s.lastTurnMs, 0, "an exit before any prompt must not read as a finished turn");
});

await test("/clear drops the span along with the conversation it belonged to", () => {  const s = makeSession();
  s.emitNormalized("user_message", { text: "hi" });
  s.emitNormalized("turn_complete", { stats: {} });
  s.lastTurnMs = 900;
  s.sendPrompt("/clear");
  assert.equal(s.lastTurnMs, 0);
  assert.equal(publicSession(s).lastTurnMs, null, "null, not 0 — the pane reads 0 as falsy anyway");
});

await test("a reset states the log's own turn state — the client clears it a frame later", () => {
  // The host broadcasts conversation_reset alongside every hydrate, and the client applies
  // it AFTER the ack that carried the same state. A reset that stayed silent would wipe
  // the summary the ack had just restored, which is the whole point of the change.
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event, data) => { if (event === "conversation_reset") seen.push(data); };
  s.lastTurnMs = 1500;
  s.cliSessionId = "fake-id";
  s._rebuildFromStore = () => [
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "turn_complete", data: {} }
  ];
  assert.equal(s.refreshFromStore(), true);
  assert.equal(seen.at(-1).lastTurnMs, 1500);
  // The rebuild does not re-emit the turn, so the span must survive it untouched.
  assert.equal(s.lastTurnMs, 1500);
});

await test("a F5 mid-turn resets to RUNNING, with the duration to count from", () => {
  // The bug this pins: restoring only the span left the pane printing "Worked for …" over
  // an answer that was still streaming, because the reset had just said the turn was over.
  //
  // The state carries a DURATION, never the host's timestamp: the two machines sit on
  // different clocks, so a client subtracting one from the other would print the skew.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake-id";
  s._rebuildFromStore = () => [{ seq: 1, event: "user_message", data: { text: "hi" } }];
  s.isTurnRunning = true;
  s.turnStartedAt = Date.now() - 5000;
  const reset = [];
  s.onEvent = (id, event, data) => { if (event === "conversation_reset") reset.push(data); };
  s.refreshFromStore();
  assert.equal(reset.at(-1).isTurnRunning, true);
  assert.ok(reset.at(-1).elapsedMs >= 5000, `expected ~5000ms, got ${reset.at(-1).elapsedMs}`);
  assert.equal(reset.at(-1).lastTurnMs, 0, "a running turn has no span to print");
  assert.equal(reset.at(-1).turnStartedAt, undefined, "a host mark would be read on the wrong clock");
});

// ── Async rows: work that outlives its own turn ──

await test("a launch ack arms a watchdog, and the settle closes the row", () => {
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event, data) => seen.push({ event, data });
  // What the adapter now emits for "Async agent launched successfully…".
  s.emitNormalized("tool_result", { id: "t1", name: "Agent", output: "…", status: "running", async: true, handle: "a1" });
  assert.equal(s.asyncTimers.size, 1, "the row is being watched");

  s.emitNormalized("tool_result", { id: "t1", status: "done" });
  assert.equal(seen.at(-1).data.status, "done", "a real result settles the row");
  assert.equal(s.asyncTimers.size, 0, "and stops the clock");
});

await test("an ordinary result does not arm anything", () => {
  const s = makeSession();
  s.onEvent = () => {};
  s.emitNormalized("tool_result", { id: "t2", name: "Bash", status: "done" });
  assert.equal(s.asyncTimers.size, 0);
});

await test("the watchdog's own settle does not re-arm itself", () => {
  // Keyed on `handle`, not `async`: the settle event carries `async` too, so arming on
  // that would restart the clock every time it fired and the row would never end.
  const s = makeSession();
  s.onEvent = () => {};
  s.emitNormalized("tool_result", { id: "t3", status: "done", async: true });
  assert.equal(s.asyncTimers.size, 0, "a settle event carries no handle, so nothing is armed");
});

await test("a stop settles async work — the CLI that launched it is gone", () => {
  const s = makeSession();
  s.onEvent = () => {};
  s.adapter = { stop: () => {} };
  s.emitNormalized("tool_result", { id: "t4", name: "Bash", status: "running", async: true, handle: "s1" });
  assert.equal(s.asyncTimers.size, 1);
  s.clearAllAsyncWatchdogs();
  assert.equal(s.asyncTimers.size, 0);
});

await test("a restored log settles rows whose watchdog died with the process", () => {
  // Without this the row spins forever: the client deliberately keeps `async` rows live
  // past their turn, and the timer that would have closed it did not survive the restart.
  const s = makeSession();
  s.history = [
    { seq: 1, event: "tool_result", data: { id: "t5", name: "Agent", status: "running", async: true, handle: "a9" } },
    { seq: 2, event: "tool_result", data: { id: "t6", name: "Bash", status: "done" } }
  ];
  s._settleRestoredAsync();
  assert.equal(s.history[0].data.status, "done", "the orphaned row is closed");
  assert.equal(s.history[1].data.status, "done", "an already-settled row is left alone");
});


await test("a task record survives in the log as the harness wrote it", () => {
  // The pane rebuilds from the log on every hydrate, so a task the CLI announced has to
  // be IN that log — under the harness's own type/subtype and field names, since the pane
  // folds records with one reader and nothing renames them on the way.
  const s = makeSession();
  s.emitNormalized("cli_event", {
    type: "system", subtype: "task_started",
    record: { type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "call-1", is_backgrounded: true }
  });
  const rec = s.history.filter((e) => e.event === "cli_event" && e.data.subtype === "task_started");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].data.record.task_id, "t-1");
  assert.equal(rec[0].data.record.is_backgrounded, true, "the CLI's own field name, not a rename");
  assert.equal(publicSession(s).events.some((e) => e.data?.subtype === "task_started"), true,
    "and it rides the replay window, or a reopen shows nothing pinned");
});

await test("an event the pane has no card for is still kept, whole", () => {
  // The pane is a re-render of the TUI, not a summary: a record it cannot draw yet must
  // not be dropped on the way to the log, or the gap becomes permanent and silent.
  const s = makeSession();
  s.emitNormalized("cli_event", { type: "system", subtype: "api_retry", record: { attempt: 2 } });
  const kept = s.history.filter((e) => e.event === "cli_event");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].data.subtype, "api_retry");
  assert.equal(kept[0].data.record.attempt, 2);
});

await test("an attachment loses the two fields no reader touches, and keeps the rest", () => {
  // `rendered` is the harness's own TUI text and `snippet` the whole file re-read — 30% of
  // a 6.7MB log on a real chat, in a window that is 32KB. The pane reads `attachment.content`
  // / `filename` / `prompt`, which is what stays.
  const s = makeSession();
  s.emitNormalized("cli_event", {
    type: "attachment", subtype: "hook_success",
    record: {
      uuid: "u-1", rendered: [{ content: "x".repeat(9000) }],
      attachment: { type: "hook_success", hookEvent: "SessionStart", content: "hello", stdout: "hello" }
    }
  });
  const rec = s.history.find((e) => e.event === "cli_event").data.record;
  assert.equal("rendered" in rec, false, "the harness's own rendering is not the log's business");
  assert.equal(rec.attachment.content, "hello", "what the pane reads survives");
  assert.equal(rec.attachment.stdout, "hello");
  assert.equal(rec.uuid, "u-1");
});

await test("an edited file keeps its filename and loses the body", () => {
  // The snippet is the WHOLE file (8KB measured), not the change — and the transcript
  // path already dropped it, so the live path showing it was the two doors disagreeing.
  const s = makeSession();
  s.emitNormalized("cli_event", {
    type: "attachment", subtype: "edited_text_file",
    record: { attachment: { type: "edited_text_file", filename: "/tmp/a.mjs", snippet: "y".repeat(8000) } }
  });
  const a = s.history.find((e) => e.event === "cli_event").data.record.attachment;
  assert.equal(a.filename, "/tmp/a.mjs");
  assert.equal("snippet" in a, false);
});


// ── a chat that is quietly working is not a chat that is stuck ──

await test("a chat turn with no PTY is not judged quiet from a clock nothing stamps", () => {
  // `armIdleWatchdog` measures silence with `getLastOutputAt(sessionId)` — a map the PTY
  // writes on every chunk. A chat session HAS no PTY, so that reading is 0 ("never"), and
  // `quietFor` is the whole age of the process: every chat turn looked stalled from birth
  // and the watchdog SIGINTed a CLI that was working. The chat's own sign of life is the
  // events the adapter feeds it, so the clock must be stamped there too.
  const s = makeSession();
  s.onEvent = () => {};
  s.adapter = { stop() {} };
  const before = Date.now();
  s.emitNormalized("delta", { text: "working" });
  const stamped = getLastOutputAt(s.id);
  assert.ok(stamped >= before, `a chat event must stamp the output clock, got ${stamped}`);
  assert.ok(Date.now() - stamped < 1000, "and it must be now, not the epoch");
});

await test("a tool the CLI is running is not a stall either", () => {
  // The CLI emits NOTHING between a tool call and its result — measured: a 75s `sleep`
  // produced zero events in between. So a turn waiting on a slow tool is indistinguishable
  // from a stuck one by silence alone, and the record that says so is the tool call itself.
  const s = makeSession();
  s.onEvent = () => {};
  s.adapter = { stop() {} };
  s.emitNormalized("tool_start", { id: "t1", name: "Bash", input: { command: "sleep 75" } });
  assert.ok(Date.now() - getLastOutputAt(s.id) < 1000, "the call is the sign of life");
});

await test("the CLI's own end signal disarms the clock the regex armed", () => {
  // Two signals for one task: the launch ack arms the fallback timer, and the CLI's
  // task_notification is the real end. Without this the row keeps a 120s clock running
  // against work the CLI has already reported finished.
  const s = makeSession();
  s.onEvent = () => {};
  s.adapter = { stop() {} };
  s.emitNormalized("tool_result", { id: "call-1", async: true, handle: "t-1", status: "running" });
  assert.equal(s.asyncTimers.has("call-1"), true, "the fallback clock is armed");
  s.emitNormalized("cli_event", {
    type: "system", subtype: "task_notification",
    record: { type: "system", subtype: "task_notification", task_id: "t-1", tool_use_id: "call-1", status: "completed" }
  });
  assert.equal(s.asyncTimers.has("call-1"), false, "the real end signal disarms it");
});

await test("a task_notification for another call leaves this clock alone", () => {
  const s = makeSession();
  s.onEvent = () => {};
  s.adapter = { stop() {} };
  s.emitNormalized("tool_result", { id: "call-1", async: true, handle: "t-1", status: "running" });
  s.emitNormalized("cli_event", {
    type: "system", subtype: "task_notification",
    record: { type: "system", subtype: "task_notification", task_id: "t-9", tool_use_id: "call-9", status: "completed" }
  });
  assert.equal(s.asyncTimers.has("call-1"), true, "someone else's task ending is not this one's");
});


// ── a rebuild must not wipe what the transcript cannot rebuild ──

await test("harness records survive a hydrate's rebuild", () => {
  // Every hydrate (F5, a second tab, a reconnect) goes through doorSession → refreshFromStore,
  // which REPLACES the log with what the CLI's transcript can reconstruct. The transcript
  // holds the conversation; it does not hold the harness's live records — `task_started`,
  // `background_tasks_changed`, `status`, `hook_*` are not written there at all (measured:
  // 0 of them in 934 transcripts). So the rebuild dropped every one of them, and the pane
  // came back from a reload with an empty task strip while work was still running.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake";
  s._rebuildFromStore = () => [{ seq: 1, event: "user_message", data: { text: "hi" } }];

  s.emitNormalized("cli_event", { type: "system", subtype: "task_started", record: { task_id: "t-1", is_backgrounded: true } });
  assert.equal(s.history.filter((e) => e.event === "cli_event").length, 1, "recorded while live");

  s.refreshFromStore();
  assert.equal(s.history.filter((e) => e.event === "cli_event").length, 1,
    "and still there after the rebuild — the transcript cannot give it back");
});

await test("a carried record keeps its place in the conversation", () => {
  // Nailing the carried records to the END put a task from turn 1 after turn 2's prompt —
  // the pane reads order as arrival, so a notice or a task would surface under the wrong
  // turn. The transcript's own events carry no timestamp, so position has to be decided by
  // something the log DOES know: how many live events preceded the record.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake";
  s._rebuildFromStore = () => [
    { seq: 1, event: "user_message", data: { text: "turn 1" } },
    { seq: 2, event: "turn_complete", data: {} },
    { seq: 3, event: "user_message", data: { text: "turn 2" } }
  ];
  s.emitNormalized("user_message", { text: "turn 1" });
  s.emitNormalized("turn_complete", { stats: {} });
  s.emitNormalized("cli_event", { type: "system", subtype: "task_notification", record: { task_id: "t-old", status: "completed" } });
  s.emitNormalized("user_message", { text: "turn 2" });

  s.refreshFromStore();
  const kinds = s.history.map((e) => e.event + (e.data?.subtype ? `:${e.data.subtype}` : ""));
  const at = kinds.findIndex((k) => k.startsWith("cli_event"));
  const turn2 = kinds.indexOf("user_message", 2);
  assert.ok(at !== -1, "the record survives the rebuild");
  assert.ok(at < turn2, `the record belongs to turn 1, before turn 2 — got ${kinds.join(", ")}`);
});

await test("a shorter rebuild does not duplicate or pile up the carried records", () => {
  // The rebuild is usually SHORTER than the log it replaces — the head is shed past
  // AI_MAX_EVENTS, and the transcript only rebuilds what it holds. Comparing an old index
  // against the new array put every record past its end, which both moved them to the tail
  // AND left the earlier ones unfiled: the log came back with each record twice.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake";
  // Two records, far apart in the live log.
  s.emitNormalized("user_message", { text: "u1" });
  s.emitNormalized("cli_event", { type: "system", subtype: "informational", record: { content: "noteA" } });
  s.emitNormalized("user_message", { text: "u2" });
  s.emitNormalized("cli_event", { type: "system", subtype: "informational", record: { content: "noteB" } });
  // The transcript gives back a single turn — the common case after the head is shed.
  s._rebuildFromStore = () => [{ seq: 1, event: "user_message", data: { text: "u2" } }];
  s.refreshFromStore();

  const notes = s.history.filter((e) => e.event === "cli_event").map((e) => e.data.record.content);
  assert.deepEqual(notes, ["noteA", "noteB"], "each record exactly once, in arrival order");
  assert.equal(s.history.filter((e) => e.event === "user_message" && e.data.text === "u2").length, 1,
    "the rebuilt turn is still there, and not duplicated by the merge");
  // They land after `u2` on purpose: `u1` is not in the rebuilt log, so the position they
  // were anchored to is gone, and the end is the only honest answer left. What must hold
  // is that they are each there once and keep their order relative to each other.
});

await test("telemetry does not crowd the conversation out of the replay window", () => {
  // The user-visible bug: after a while, scrolling up showed nothing and an F5 came back
  // empty. Measured on a live session — telemetry (`thinking_tokens`, `hook_*`) was 8.6% of
  // the log but **807% of one AI_REPLAY_BYTES window**, so the window the client is sent was
  // almost entirely telemetry and the prompts and answers fell outside it. Paging could not
  // help: every page was telemetry again.
  //
  // The harness does not keep these (0 records across a 7.7MB transcript), so logging them
  // is 9Remote adding noise the CLI itself discards.
  const s = makeSession();
  s.onEvent = () => {};
  s.emitNormalized("user_message", { text: "a question worth keeping" });
  s.emitNormalized("turn_complete", { stats: {} });
  for (let i = 0; i < 400; i++) {
    s.emitNormalized("cli_event", { type: "system", subtype: "thinking_tokens", record: { estimated_tokens: i, estimated_tokens_delta: 1, uuid: `u-${i}`, session_id: "s" } });
  }
  const { events } = replayWindow(s.history, AI_REPLAY_BYTES);
  assert.ok(events.some((e) => e.event === "user_message"),
    "the prompt must survive in the window the pane is sent");
});

await test("a hook's attachment reaches the live log at the turn's end", () => {
  // The live door cannot see one (stream-json does not emit `attachment`), so the session
  // reads the transcript's tail at each turn boundary and emits what appeared. Turn end is
  // the natural beat: the harness has written the turn's records by then, and it costs one
  // tail read per turn rather than a poll.
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event, data) => seen.push({ event, data });
  s.cliSessionId = "fake";
  s.attachmentOffset = 0;
  s._readAttachments = () => ({
    records: [{ type: "attachment", attachment: { type: "hook_success", content: "injected context" } }],
    offset: 42
  });

  s.emitNormalized("user_message", { text: "hi" });
  s.emitNormalized("turn_complete", { stats: {} });

  const emitted = seen.filter((e) => e.event === "cli_event" && e.data?.subtype === "hook_success");
  assert.equal(emitted.length, 1, "the hook's output reaches the pane without a reload");
  assert.equal(emitted[0].data.record.attachment.content, "injected context");
  assert.equal(s.attachmentOffset, 42, "and the offset moves, so the next read does not repeat it");
});

await test("a session does not replay attachments the pane already drew", () => {
  // Starting the offset at 0 read every attachment the conversation ever had — measured 72
  // `hook_success` from turns already on screen. The rebuild puts this conversation's
  // history in the log; reading it again is a second copy, not news.
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event, data) => seen.push({ event, data });
  s.cliSessionId = "fake";
  s.attachmentOffset = null;
  s._seedAttachmentOffset = () => ({ offset: 5000 });

  s.emitNormalized("user_message", { text: "hi" });
  s.emitNormalized("turn_complete", { stats: {} });

  assert.equal(seen.filter((e) => e.data?.subtype === "hook_success").length, 0, "nothing replayed");
  assert.equal(s.attachmentOffset, 5000, "and the offset is seeded, so the NEXT turn reads news only");
});

await test("an attachment lands inside the turn it belongs to", () => {
  // The harness writes an attachment for what it put into THIS turn, so it belongs before
  // the turn_complete that ends it. Emitted after, a hook's output showed up under the
  // NEXT prompt — which a replay would never do, since the transcript has them in the order
  // they happened, and the two doors would disagree.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake";
  s.attachmentOffset = 0;
  s._readAttachments = () => ({
    records: [{ type: "attachment", attachment: { type: "hook_success", content: "context" } }],
    offset: 99
  });

  s.emitNormalized("user_message", { text: "hi" });
  s.emitNormalized("turn_complete", { stats: {} });

  const kinds = s.history.map((e) => (e.event === "cli_event" ? `cli:${e.data.subtype}` : e.event));
  assert.deepEqual(kinds, ["user_message", "cli:hook_success", "turn_complete"]);
});

// ── there is no watchdog, the TUI way ──

await test("a quiet turn is left alone — no kill, no report", () => {
  // The TUI has no watchdog at all. It emits `tool_heartbeat` every 30s while a tool runs
  // and never kills one, however long — the reader watches the elapsed seconds and decides.
  // 9Remote's 120s SIGINT was our own invention: it killed slow tools that were working (a
  // 150s `sleep` is a normal thing to run), and reporting instead of killing still moved the
  // status dot, because `stall` maps to `idle` and therefore ends the turn.
  //
  // So it is gone. What replaces it is nothing: a turn that says nothing is a turn that is
  // still running, and the Stop control is the user's.
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event) => seen.push(event);
  let killed = false;
  s.adapter = { stop() { killed = true; }, pendingRequests: new Map() };
  s.isTurnRunning = true;
  s.turnStartedAt = Date.now() - 10 * 60 * 1000;   // ten quiet minutes

  s.emitNormalized("delta", { text: "still here" });

  assert.equal(killed, false, "the CLI is left alone");
  assert.equal(seen.includes("stall"), false, "and nothing is reported");
  assert.equal(s.isTurnRunning, true, "the turn is still the turn");
  assert.equal(s.idleTimer, undefined, "and there is no clock at all — the field is gone with it");
});


// ── the log must not be flooded by what the harness itself refuses to persist ──

await test("telemetry the harness does not keep does not push the log past its cap", () => {
  // The bug this pins, reported from real use: scrolling up after a while showed nothing.
  // Measured on a live session — the log sat at 4984 of AI_MAX_EVENTS (5000), and the head
  // it sheds is where the PROMPTS are. 1003 of those events were `thinking_tokens`, which
  // the harness does NOT write to its own transcript (0 records in a 7.7MB session file):
  // it streams them and lets them go. Logging them costs the history the pane pages back.
  //
  // Nothing is lost by not logging them: they are live-only facts — a token estimate for a
  // spinner — and no reader ever replays one.
  const s = makeSession();
  s.onEvent = () => {};
  const before = s.history.length;
  for (let i = 0; i < 50; i++) {
    s.emitNormalized("cli_event", { type: "system", subtype: "thinking_tokens", record: { estimated_tokens: i } });
  }
  assert.equal(s.history.length, before, "50 telemetry records cost the log nothing");
});

// ── a tool result the CLI persisted is a path, not 15KB of frame ──

await test("a persisted tool result reaches the pane as the file it saved to", () => {
  // Reported from real use: the chat drew the whole `<persisted-output>` frame — 15.8KB of
  // XML saying the real output went to a file. Measured on a real session: 9 `Bash` results
  // carried it. The frame is the harness talking to itself; the path is what a reader can
  // use, and the file holds the rest.
  const s = makeSession();
  s.onEvent = () => {};
  const frame = "<persisted-output>\nOutput too large (2MB). Full output saved to: /tmp/tool-results/abc.txt\nPreview (first 2KB): junk…\n</persisted-output>";
  s.emitNormalized("tool_result", { id: "t1", name: "Bash", output: frame, status: "done" });

  const kept = s.history.find((e) => e.event === "tool_result")?.data.output;
  assert.match(kept, /saved to: \/tmp\/tool-results\/abc\.txt/, "the path survives");
  assert.doesNotMatch(kept, /<persisted-output>/, "the frame does not");
  assert.doesNotMatch(kept, /Preview/, "nor the preview dump");
});

await test("an ordinary tool result is left exactly as it was", () => {
  const s = makeSession();
  s.onEvent = () => {};
  s.emitNormalized("tool_result", { id: "t2", name: "Bash", output: "hello\nworld", status: "done" });
  assert.equal(s.history.find((e) => e.event === "tool_result").data.output, "hello\nworld");
});

console.log(`\nAll tests passed: ${pass}/${pass}`);
