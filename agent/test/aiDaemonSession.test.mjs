// Tests for the daemon-owned AI session layer (agent/features/terminal/ptyDaemon.js)
// Run: node agent/test/aiDaemonSession.test.mjs
//
// These assert the invariants that make the AI chat behave like the terminal:
// one host-owned log every client replays, seq-stamped so replay and live events
// cannot double-apply, and control-request ids that survive the IPC hop.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

const root = path.resolve(import.meta.dirname, "..", "..");
const DAEMON = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemon.js"), "utf8");
// The transcript lookup lives in its own module now — the daemon imports it, and
// these two invariants are asserted against where the code actually is.
const TRANSCRIPT = fs.readFileSync(path.join(root, "agent/features/ai/claudeTranscript.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemonClient.js"), "utf8");
const HOOK = fs.readFileSync(path.join(root, "web/features/ai/hooks/useAiSession.js"), "utf8");
const SOCKET = fs.readFileSync(path.join(root, "agent/features/ai/aiSocket.js"), "utf8");

console.log("Running AI daemon session tests...");

// ── Where the chat layer lives ──
//
// The split that matters: the daemon runs the CLI process and relays numbered lines;
// the agent parses them, owns the log and the snapshot. These assertions hold each
// side to its own half — a regression here is a chat that dies with the agent.

test("the daemon relays lines and never parses an engine's protocol", () => {
  // Raw lines, numbered, in arrival order, from both streams: that is the whole
  // contract. Nothing in the daemon may know what a stream-json message looks like.
  assert.match(DAEMON, /broadcast\(\{ type: "procLine", procId, epoch: proc\.epoch, n: proc\.lineCount/);
  // Dispatched through the route table, not a switch arm: the daemon's own message
  // handling is now one lookup, and the routes live beside the state they touch.
  assert.match(DAEMON, /lines: \(m\) => \{/);
  assert.match(DAEMON, /function createProc\(procId, \{ bin, args = \[\], cwd, env \} = \{\}\)/);
  for (const engineWord of ["stream_event", "control_request", "turn_complete", "claude"]) {
    assert.ok(!DAEMON.includes(engineWord), `the daemon must not know "${engineWord}"`);
  }
});

test("a proc is adopted, never restarted, when an agent re-attaches", () => {
  // Starting a second CLI on the same conversation would double-write its transcript
  // and lose the turn that was in flight — the exact thing the daemon exists to keep.
  assert.match(DAEMON, /function attachProc\(procId, from = 0\)/);
  // Attaching never starts anything: the running process IS the session, and a second
  // one would resume the same conversation as a second writer. `oldest` rides along so
  // a reader that asked from too far back learns how much it can no longer fetch.
  assert.match(DAEMON, /alive: !proc\.exited,\s*epoch: proc\.epoch,\s*lines: procLinesSince\(proc, from\),\s*total: proc\.lineCount,\s*oldest: proc\.lines\[0\]\?\.n/);
  const PROC = fs.readFileSync(path.join(root, "agent/features/ai/proc/daemonProc.js"), "utf8");
  assert.match(PROC, /async attach\(from = 0, epoch = null\) \{/);
  assert.match(PROC, /this\.client\.procAttach\(this\.procId, from\)/);
});

test("the agent asks for the lines it has not consumed, and only those", () => {
  // The watermark is the daemon's own line number, stored in the snapshot: a restart
  // resumes from it, which is what makes a turn survive the agent being killed.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  const PROC = fs.readFileSync(path.join(root, "agent/features/ai/proc/daemonProc.js"), "utf8");
  assert.match(SESSION, /consumedLines: this\.consumedLines,/);
  assert.match(SESSION, /adapter\.adopt\(this\.consumedLines\)/);
  assert.match(SESSION, /this\.consumedLines = this\.proc\?\.lastLine \|\| 0;/);
  // Fetched lines are base64 (the daemon counts bytes); live ones are already text.
  assert.match(PROC, /export function decodeLine\(line\)/);
  assert.match(PROC, /Buffer\.from\(line\.data, "base64"\)\.toString\("utf8"\)/);
  // Lines arriving while a fetch is in flight wait for it, so the caller always
  // parses in line order and the replay cannot interleave with live output.
  // The hold opens BEFORE the request, or a line the fetch also carries is delivered twice.
  assert.match(PROC, /_openHold\(\)/);
  assert.match(PROC, /if \(held\.n <= this\._lastLine\) continue;/);
});

test("a killed agent does not lose the turn it was streaming", () => {
  // A snapshot written only at turn boundaries leaves an empty pane after a hard kill.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /scheduleSaveSnapshot\(\)/);
  assert.match(SESSION, /AI_PERSIST_DEBOUNCE_MS/);
  assert.match(SESSION, /if \(record\) this\.scheduleSaveSnapshot\(\);/);
  // ...and a turn boundary still pays a synchronous write, so an exchange that just
  // finished is never left in the debounce window.
  assert.match(SESSION, /flushSaveSnapshot\(\)/);
  assert.match(SESSION, /fs\.writeFileSync\(aiSnapshotFile\(this\.id, this\.engine\), payload\)/);
});

test("the agent owns the chat snapshot, under the agent's own root", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  // A hardcoded ~/.9remote would ignore a relocated instance (and a test run).
  assert.match(SESSION, /const AI_SESSIONS_DIR = PATHS\.AI_SESSIONS;/);
  assert.doesNotMatch(SESSION, /os\.homedir\(\), "\.9remote"/);
});

// ── Event log + seq watermark ──

test("every event carries a monotonic seq", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /const seq = this\.history\.length \+ 1;/);
  assert.match(SESSION, /this\.history\.push\(\{ seq, event: wire\.event, data, timestamp: Date\.now\(\) \}\);/);
});

test("the published watermark is the newest seq, not the log's length", () => {
  // Past AI_MAX_EVENTS the log sheds its head, so length stops equalling the highest
  // seq — the client gates on this number and would drop an event if it were short.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SOCKET, /seq: session\.history\.at\(-1\)\?\.seq \?\? 0/);
  assert.match(SESSION, /const seq = this\.history\.length \+ 1;/);
  // AI_MAX_EVENTS trims the head, which is exactly what decouples the two.
  assert.match(SESSION, /this\.history\.length > AI_MAX_EVENTS/);
});

test("a rebuilt log is delivered like a hydrate: a tail plus where the window starts", () => {
  // /resume used to push the WHOLE conversation down the live bus (measured 6.2x the
  // tail on an 900-event chat, and far worse on a real one). Opening the same
  // conversation from the history list ships a tail and leaves the rest to the
  // scroll-up fetch — /resume must do the same, and the reset has to say where the
  // window begins or scroll-up re-fetches what the tail already replayed.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /_adoptLog\(events\) \{/);
  assert.match(SESSION, /const from = aiTailStart\(log, AI_REPLAY_BYTES\)/);
  assert.match(SESSION, /hasMore: from > 0,\s*fromSeq: log\[from\]\?\.seq \?\? 0/);
  assert.match(SESSION, /for \(const ev of log\.slice\(from\)\) this\.onEvent\?\.\(this\.id, ev\.event, ev\.data, ev\.seq\)/);
  // Every path that replaces the log with real content goes through it: /resume and
  // the gap rebuild. /clear is the third reset but ships an empty window directly —
  // there is nothing to page.
  const callers = (SESSION.match(/this\._adoptLog\(/g) || []).length;
  assert.equal(callers, 2, `resume and gap must share the one delivery, saw ${callers}`);
  // ...and /clear still states the empty window rather than sending no payload at all.
  assert.match(SESSION, /conversation_reset", \{ hasMore: false, fromSeq: 0 \}/);
});

test("a hydrate ack ships a tail and says there is more — that is what arms scroll-up", () => {
  // Shipping the whole log stalls a phone (6.9 MB measured on one real chat), and a
  // log that ships whole must report hasMore:false or the client's scroll-up fetches
  // a window it already has and renders every turn twice.
  assert.match(SOCKET, /function publicSession\(session, extra = \{\}\)/);
  assert.match(SOCKET, /const from = aiTailStart\(session\.history, AI_REPLAY_BYTES\)/);
  assert.match(SOCKET, /events: from > 0 \? session\.history\.slice\(from\) : session\.history,/);
  assert.match(SOCKET, /hasMore: from > 0,/);
  // Every answer that hydrates a client carries it: a fresh create, a re-mount of a
  // live one, and the wait for a create already in flight.
  assert.equal((SOCKET.match(/session: publicSession\(/g) || []).length, 3);
});

test("a thin snapshot is topped up from the CLI's own transcript", () => {
  // A legacy snapshot, or one written just before a crash, holds a turn or two while
  // the CLI's transcript holds the conversation. Without this the pane reopens on a
  // stub. Never downward: a fuller snapshot is left alone.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /this\.history\.filter\(\(e\) => e\.event === "user_message"\)\.length <= 1/);
  assert.match(SESSION, /recoveredTurns > snapTurns/);
});

test("live events are gated by the client's applied-seq watermark", () => {
  assert.match(HOOK, /appliedSeqRef/);
  assert.match(HOOK, /payload\.seq <= appliedSeqRef\.current/);
  // Unstamped (legacy in-agent) events must still pass through
  assert.match(HOOK, /if \(payload\.seq != null\) \{/);
});

// ── Permission / question correlation ──

test("a resolved gate broadcasts so other surfaces drop their card", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /this\.emitNormalized\("permission_resolved", \{ requestId, behavior \}\)/);
  assert.match(HOOK, /case "permission_resolved":/);
});

// ── Session lifecycle ──

test("a create for a live session returns it instead of rebuilding it", () => {
  // Every mount re-creates. Rebuilding would kill the CLI and the turn in flight.
  assert.match(SOCKET, /if \(manager\.getSession\(sessionId\)\) \{/);
});

test("a mode/model change mid-turn is deferred, not dropped", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /if \(this\.isTurnRunning\) \{\s*this\.restartPending = true;/);
  assert.match(SESSION, /applyPendingOptions\(\)/);
  assert.match(SESSION, /this\.history = compactEvents\(this\.history\);\s*this\.flushSaveSnapshot\(\);\s*this\.applyPendingOptions\(\);/);
});

test("Stop interrupts the turn instead of killing the CLI process", () => {
  const ADAPTER = fs.readFileSync(path.join(root, "agent/features/ai/adapters/claudeAdapter.js"), "utf8");
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(ADAPTER, /interrupt\(\) \{/);
  assert.match(ADAPTER, /subtype: "interrupt", cancel_queued: true/);
  // SIGINT is only the fallback when the control request could not be written
  assert.match(SESSION, /const sent = this\.adapter\?\.interrupt\?\.\(\);/);
  assert.match(SESSION, /if \(!sent\) this\.adapter\?\.signal\?\.\("SIGINT"\);/);
});

test("/clear mid-turn stops the turn and resets, instead of stranding an empty pane", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  // The session refuses to rebuild over a running turn (that would kill the CLI mid-turn).
  assert.match(SESSION, /Turn is still running — stop it before \/clear\./);
  // ...so the socket stops it FIRST. The pane has already dropped its own log by then,
  // and a refusal would leave the user on a blank chat with no way back.
  assert.match(SOCKET, /if \(String\(message\)\.trim\(\) === "\/clear" && session\.isTurnRunning\) session\.stop\(\);/);
  // A fresh process numbers its lines from scratch, so the watermark resets with it.
  assert.match(SESSION, /this\.consumedLines = 0;/);
});

test("an agent restart that loses a conversation drops the refused resume id", () => {
  const ADAPTER = fs.readFileSync(path.join(root, "agent/features/ai/adapters/claudeAdapter.js"), "utf8");
  // The CLI emits no init until the first prompt, so a clean pre-init exit proves
  // nothing; only a failure is evidence the id was refused.
  assert.match(ADAPTER, /this\.metadata\.sessionId && !this\._initializedThisSpawn && \(code \|\| error\)/);
  assert.match(ADAPTER, /this\.resumeRejected = true;/);
});

// ── Persistence ──

test("tool output is capped before it enters the re-serialized log", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /if \(event === "tool_result"\) data = capToolOutput\(data\);/);
  assert.match(SESSION, /function capToolOutput\(data\)/);
});

// ── Reducer coverage ──

test("the web reducer handles every event the agent emits", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  const ADAPTER = fs.readFileSync(path.join(root, "agent/features/ai/adapters/claudeAdapter.js"), "utf8");
  const emitted = [...new Set([
    ...[...SESSION.matchAll(/emitNormalized\("([a-z_]+)"/g)].map((m) => m[1]),
    ...[...ADAPTER.matchAll(/this\.onEvent\?\.\("([a-z_]+)"/g)].map((m) => m[1]),
  ])];
  assert.ok(emitted.length >= 8, `expected several events, saw ${emitted.length}`);
  const unhandled = emitted.filter((e) => !HOOK.includes(`case "${e}":`));
  // ansi is intentionally terminal-only chrome, not chat content; init is applied by
  // the reducer's metadata branch rather than a case.
  assert.deepStrictEqual(unhandled.filter((e) => e !== "ansi" && e !== "init"), []);
});

test("every local module the daemon imports is copied into its runtime folder", () => {
  // The dev-mode runtime copy is an allowlist. A module the daemon imports but the
  // copy forgets makes the daemon die at import — and since the daemon serves the
  // terminals too, that is every terminal gone until DAEMON_VERSION is bumped.
  const listed = /const DAEMON_LOCAL_MODULES = \[([^\]]+)\]/.exec(CLIENT);
  assert.ok(listed, "DAEMON_LOCAL_MODULES must exist");
  const copied = new Set([...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const siblingsOf = (file) => [...file.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]);
  const queue = siblingsOf(DAEMON);
  const walk = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (walk.has(name)) continue;
    walk.add(name);
    const full = path.join(root, "agent/features/terminal", name);
    if (!fs.existsSync(full)) continue;
    queue.push(...siblingsOf(fs.readFileSync(full, "utf8")));
  }
  const missing = [...walk].filter((f) => !copied.has(f));
  assert.deepEqual(missing, [], `not copied into the daemon runtime folder: ${missing.join(", ")}`);
});

test("the daemon never imports outside its own folder", () => {
  // The runtime copy mirrors features/terminal/ plus lib/constants.js and nothing else.
  // An `../` import resolves only on the developer's machine: in the shipped (or freshly
  // copied) daemon it is a missing file, so the daemon dies at import and every terminal
  // is gone until the version is bumped.
  const escaping = [...DAEMON.matchAll(/from "(\.\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(escaping, [], `daemon imports outside features/terminal: ${escaping.join(", ")}`);
});

test("two mounts of one chat cannot build it twice", () => {
  // A reconnect and a second tab both miss the "already live" check while the first
  // create is still awaiting its CLI. Without a shared gate the second builds and
  // starts the same session, and the second process kills the first one's turn.
  assert.match(SOCKET, /const creating = new Map\(\)/);
  assert.match(SOCKET, /if \(creating\.has\(sessionId\)\) \{/);
  assert.match(SOCKET, /creating\.set\(sessionId, \{ session, done: new Promise/);
  // Released in a finally: a failed create must not wedge the id forever.
  assert.match(SOCKET, /\} finally \{\s*creating\.delete\(sessionId\);/);
  // A prompt that has to auto-create waits on the same gate rather than racing it.
  assert.match(SOCKET, /await creating\.get\(sessionId\)\.done;/);
});

test("a destroyed chat cannot come back from its own stop event", () => {
  // destroy() starts an async adapter stop; that stop emits 'exit', which schedules a
  // debounced snapshot write. Deleting the file first puts it straight back.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /const stopped = this\.options\.mock \? Promise\.resolve\(\) : this\.adapter\?\.stop\(\);/);
  assert.match(SESSION, /if \(stopped\?\.then\) stopped\.then\(drop, drop\);/);
  // ...and it leaves the registry BEFORE that IPC, so a create cannot adopt a dying one.
  const MANAGER = fs.readFileSync(path.join(root, "agent/features/ai/aiManager.js"), "utf8");
  const body = MANAGER.slice(MANAGER.indexOf("destroySession(sessionId)"));
  assert.ok(body.indexOf("this.sessions.delete(sessionId)") < body.indexOf("session.destroy()"),
    "the session must leave the registry before the async stop starts");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
