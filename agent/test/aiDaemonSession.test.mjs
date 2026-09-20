// Run: node agent/test/aiDaemonSession.test.mjs
// Asserts daemon AI session invariants: host-owned log replay, seq-stamped events, and IPC control-request IDs.
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
const TRANSCRIPT = fs.readFileSync(path.join(root, "agent/features/ai/claudeTranscript.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemonClient.js"), "utf8");
const HOOK = fs.readFileSync(path.join(root, "web/features/ai/hooks/useAiSession.js"), "utf8");
const SOCKET = fs.readFileSync(path.join(root, "agent/features/ai/aiSocket.js"), "utf8");

console.log("Running AI daemon session tests...");

// ── Where the chat layer lives ──

test("the daemon relays lines and never parses an engine's protocol", () => {
  assert.match(DAEMON, /broadcast\(\{ type: "procLine", procId, epoch: proc\.epoch, n: proc\.lineCount/);
  assert.match(DAEMON, /lines: \(m\) => \{/);
  assert.match(DAEMON, /function createProc\(procId, \{ bin, args = \[\], cwd, env \} = \{\}\)/);
  for (const engineWord of ["stream_event", "control_request", "turn_complete", "claude"]) {
    assert.ok(!DAEMON.includes(engineWord), `the daemon must not know "${engineWord}"`);
  }
});

test("a proc is adopted, never restarted, when an agent re-attaches", () => {
  assert.match(DAEMON, /function attachProc\(procId, from = 0\)/);
  assert.match(DAEMON, /alive: !proc\.exited,\s*epoch: proc\.epoch,\s*lines: procLinesSince\(proc, from\),\s*total: proc\.lineCount,\s*oldest: proc\.lines\[0\]\?\.n/);
  const PROC = fs.readFileSync(path.join(root, "agent/features/ai/proc/daemonProc.js"), "utf8");
  assert.match(PROC, /async attach\(from = 0, epoch = null\) \{/);
  assert.match(PROC, /this\.client\.procAttach\(this\.procId, from\)/);
});

test("the agent asks for the lines it has not consumed, and only those", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  const PROC = fs.readFileSync(path.join(root, "agent/features/ai/proc/daemonProc.js"), "utf8");
  assert.match(SESSION, /consumedLines: this\.consumedLines,/);
  assert.match(SESSION, /adapter\.adopt\(this\.consumedLines, this\.consumedEpoch\)/);
  assert.match(SESSION, /consumedEpoch: this\.consumedEpoch,/);
  assert.match(SESSION, /this\.consumedLines = this\.proc\?\.lineNo \|\| 0;/);
  assert.match(PROC, /export function decodeLine\(line\)/);
  assert.match(PROC, /Buffer\.from\(line\.data, "base64"\)\.toString\("utf8"\)/);
  assert.match(PROC, /_openHold\(\)/);
  assert.match(PROC, /if \(held\.n <= this\._lastLine\) continue;/);
});

test("a killed agent does not lose the turn it was streaming", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /scheduleSaveSnapshot\(\)/);
  assert.match(SESSION, /AI_PERSIST_DEBOUNCE_MS/);
  assert.match(SESSION, /if \(record\) this\.scheduleSaveSnapshot\(\);/);
  assert.match(SESSION, /flushSaveSnapshot\(\)/);
  assert.match(SESSION, /fs\.writeFileSync\(aiSnapshotFile\(this\.id, this\.engine\), payload\)/);
});

test("the agent owns the chat snapshot, under the agent's own root", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /const AI_SESSIONS_DIR = PATHS\.AI_SESSIONS;/);
  assert.doesNotMatch(SESSION, /os\.homedir\(\), "\.9remote"/);
});

// ── Event log + seq watermark ──

test("every event carries a monotonic seq", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /const seq = \+\+this\.seqCounter;/);
  assert.match(SESSION, /this\.history\.push\(\{ seq, event: wire\.event, data, timestamp: Date\.now\(\) \}\);/);
});

test("the published watermark is the newest seq, not the log's length", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SOCKET, /seq: session\.history\.at\(-1\)\?\.seq \?\? 0/);
  assert.match(SESSION, /const seq = \+\+this\.seqCounter;/);
  assert.match(SESSION, /this\.history\.length > AI_MAX_EVENTS/);
});

test("a rebuilt log is delivered like a hydrate: a tail plus where the window starts", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /_adoptLog\(events\) \{/);
  assert.match(SESSION, /const \{ events: replay, hasMore, fromSeq \} = replayWindow\(log, AI_REPLAY_BYTES\)/);
  assert.match(SESSION, /"conversation_reset", \{\s*hasMore, fromSeq,\s*lastTurnMs: this\.lastTurnMs,\s*taskRecords: this\.taskRecords\(\),\s*\.\.\.this\.turnState\(\)\s*\}\)/);
  assert.match(SESSION, /this\.onEvent\?\.\(this\.id, ev\.event, \{ \.\.\.ev\.data, replay: true \}, ev\.seq\)/);
  const callers = (SESSION.match(/this\._adoptLog\(/g) || []).length;
  assert.equal(callers, 3, `hydrate, rewind and resume must share the one delivery, saw ${callers}`);
  assert.match(SESSION, /conversation_reset", \{\s*hasMore: false, fromSeq: 0,[^}]*taskRecords: \[\],[^}]*lastTurnMs: 0, isTurnRunning: false, elapsedMs: 0\s*\}\)/);
});

test("a hydrate ack ships a tail and says there is more — that is what arms scroll-up", () => {
  assert.match(SOCKET, /function publicSession\(session\)/);
  assert.match(SOCKET, /const \{ events, hasMore \} = replayWindow\(session\.history, AI_REPLAY_BYTES\)/);
  assert.match(SOCKET, /events,\s*hasMore,/);
  assert.equal((SOCKET.match(/\.\.\.doorSession\(/g) || []).length, 3);
});

test("one door reads the CLI's store, and nothing asks whether the log looks thin", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /_rebuildFromStore\(sessionId, leafOverride = null\) \{/);
  assert.match(SESSION, /return recovered\?\.length \? renumber\(capLog\(recovered\)\) : null;/);
  assert.ok(!SESSION.includes("isFullerLog"), "the thin-log rule must be gone, not renamed");
  assert.doesNotMatch(SESSION, /recoveredTurns > snapTurns/);
  assert.doesNotMatch(SESSION, /turns > known/);
  assert.doesNotMatch(SESSION, /recovered\.length > this\.history\.length/);
  assert.equal((SESSION.match(/_rebuildFromStore\(/g) || []).length, 5, "one definition, four callers");
});

test("an ack is rebuilt, then described — in that order, from one place", () => {
  const SOCKET = fs.readFileSync(path.join(root, "agent/features/ai/aiSocket.js"), "utf8");
  const door = SOCKET.slice(SOCKET.indexOf("function doorSession("));
  const body = door.slice(0, door.indexOf("\n}"));
  assert.ok(
    body.indexOf("session.refreshFromStore()") < body.indexOf("emitConnectMetadata("),
    "the rebuild must precede the metadata it would otherwise throw away"
  );
  assert.equal((SOCKET.match(/\.\.\.doorSession\(/g) || []).length, 3, "three doors, one builder");
  assert.equal((SOCKET.match(/session: publicSession\(/g) || []).length, 1, "publicSession is paired only in doorSession");
  assert.match(body, /session: publicSession\(session\)/);
});

test("live events are gated by the client's applied-seq watermark", () => {
  assert.match(HOOK, /appliedSeqRef/);
  const RULE = fs.readFileSync(path.join(root, "web/features/ai/lib/seqDedupe.js"), "utf8");
  assert.match(RULE, /seq <= \(appliedSeq \|\| 0\)/);
  assert.match(RULE, /if \(seq == null\) return false/);
  assert.match(HOOK, /if \(isAlreadyApplied\(payload\.seq, appliedSeqRef\.current\)\) return;/);
});

// ── Permission / question correlation ──

test("a resolved gate broadcasts so other surfaces drop their card", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /this\.emitNormalized\("permission_resolved", \{ requestId, behavior \}\)/);
  assert.match(HOOK, /case "permission_resolved":/);
});

// ── Session lifecycle ──

test("a create for a live session returns it instead of rebuilding it", () => {
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
  assert.match(SESSION, /const sent = this\.adapter\?\.interrupt\?\.\(\);/);
  assert.match(SESSION, /const signalled = sent \? false : this\.adapter\?\.signal\?\.\("SIGINT"\);/);
  assert.match(SESSION, /if \(!sent && !signalled\) \{/);
  assert.match(SESSION, /could not stop this turn — the CLI is still running\./);
});

test("every engine's adapter can actually end a turn", () => {
  for (const file of ["claudeAdapter", "codexAdapter", "opencodeAdapter", "antigravityAdapter"]) {
    const src = fs.readFileSync(path.join(root, `agent/features/ai/adapters/${file}.js`), "utf8");
    assert.match(src, /\n  interrupt\(\) \{/, `${file} must expose interrupt()`);
    assert.match(src, /\n  signal\(sig/, `${file} must expose signal()`);
  }
  const CODEX = fs.readFileSync(path.join(root, "agent/features/ai/adapters/codexAdapter.js"), "utf8");
  const SERVER = fs.readFileSync(path.join(root, "agent/features/ai/proc/codexAppServer.js"), "utf8");
  assert.match(SERVER, /if \(!this\.threadId \|\| !this\.turnId \|\| this\.closed\) return false;/);
  assert.match(SERVER, /\{ threadId: this\.threadId, turnId: this\.turnId \}/);
  assert.match(CODEX, /return Boolean\(this\.appServer\?\.interrupt\(\)\);/);
});

test("/clear mid-turn stops the turn and resets, instead of stranding an empty pane", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /Turn is still running — stop it before \/clear\./);
  assert.match(SOCKET, /if \(String\(message\)\.trim\(\) === "\/clear" && session\.isTurnRunning\) session\.stop\(\);/);
  assert.match(SESSION, /this\.consumedLines = 0;/);
});

test("an agent restart that loses a conversation drops the refused resume id", () => {
  const ADAPTER = fs.readFileSync(path.join(root, "agent/features/ai/adapters/claudeAdapter.js"), "utf8");
  assert.match(ADAPTER, /this\.metadata\.sessionId && !this\._initializedThisSpawn && \(code \|\| error\)/);
  assert.match(ADAPTER, /this\.resumeRejected = true;/);
});

// ── Persistence ──

test("every payload-bearing event is capped before it enters the re-serialized log", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /data = capEvent\(event, data\);/);
  assert.match(SESSION, /function capEvent\(event, data\)/);
  assert.match(SESSION, /capLog\(recovered\)/);
  assert.match(SESSION, /renumber\(capLog\(merged\)\)/);
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
  assert.deepStrictEqual(unhandled.filter((e) => e !== "ansi" && e !== "init"), []);
});

test("every local module the daemon imports is copied into its runtime folder", () => {
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
  const escaping = [...DAEMON.matchAll(/from "(\.\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(escaping, [], `daemon imports outside features/terminal: ${escaping.join(", ")}`);
});

test("two mounts of one chat cannot build it twice", () => {
  assert.match(SOCKET, /const creating = new Map\(\)/);
  assert.match(SOCKET, /if \(creating\.has\(sessionId\)\) \{/);
  assert.match(SOCKET, /creating\.set\(sessionId, \{ session, done: new Promise/);
  assert.match(SOCKET, /\} finally \{\s*creating\.delete\(sessionId\);/);
  assert.match(SOCKET, /await creating\.get\(sessionId\)\.done;/);
});

test("a destroyed chat cannot come back from its own stop event", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /const stopped = this\.options\.mock \? Promise\.resolve\(\) : this\.adapter\?\.stop\(\);/);
  assert.match(SESSION, /if \(stopped\?\.then\) stopped\.then\(drop, drop\);/);
  const MANAGER = fs.readFileSync(path.join(root, "agent/features/ai/aiManager.js"), "utf8");
  const body = MANAGER.slice(MANAGER.indexOf("destroySession(sessionId)"));
  assert.ok(body.indexOf("this.sessions.delete(sessionId)") < body.indexOf("session.destroy()"),
    "the session must leave the registry before the async stop starts");
});

test("session.restart resets running state and unbinds adapter before stop", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /async restart\(\) \{/);
  assert.match(SESSION, /this\.adapter = null;/);
  assert.match(SESSION, /this\.isTurnRunning = false;/);
  assert.match(SESSION, /this\.refreshFromStore\(\);/);
  assert.match(SOCKET, /socket\.on\(AI_SOCKET_EVENTS\.RESTART/);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
