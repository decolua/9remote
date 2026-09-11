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
const CLIENT = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemonClient.js"), "utf8");
const HOOK = fs.readFileSync(path.join(root, "web/features/ai/hooks/useAiSession.js"), "utf8");
const SOCKET = fs.readFileSync(path.join(root, "agent/features/ai/aiSocket.js"), "utf8");

console.log("Running AI daemon session tests...");

// ── Event log + seq watermark ──

test("aiEmit stamps a monotonic seq on every event", () => {
  assert.match(DAEMON, /const seq = s\.nextSeq\+\+;/);
  assert.match(DAEMON, /s\.events\.push\(\{ seq, event, data \}\);/);
});

test("nextSeq continues past a restored snapshot's events", () => {
  assert.match(DAEMON, /nextSeq: \(snap\?\.events\?\.reduce/);
});

test("the published state carries the watermark the client gates on", () => {
  assert.match(DAEMON, /seq: s\.nextSeq - 1/);
});

test("live events are gated by the client's applied-seq watermark", () => {
  assert.match(HOOK, /appliedSeqRef/);
  assert.match(HOOK, /payload\.seq <= appliedSeqRef\.current/);
  // Unstamped (legacy in-agent) events must still pass through
  assert.match(HOOK, /if \(payload\.seq != null\) \{/);
});

// ── Permission / question correlation ──

test("control-request ids never travel in the IPC requestId slot", () => {
  assert.match(CLIENT, /controlRequestId: requestId/);
  assert.doesNotMatch(CLIENT, /request\(\{ type: "aiPermission", sessionId, requestId \}/);
  assert.match(DAEMON, /permSession\.pendingRequests\.get\(payload\.controlRequestId\)/);
  assert.match(DAEMON, /qSession\.pendingRequests\.get\(payload\.controlRequestId\)/);
});

test("resolving a gate broadcasts so other surfaces drop their card", () => {
  assert.match(DAEMON, /aiControlResponse\(s, requestId, response, resolvedBy = ""\)/);
  assert.match(DAEMON, /aiEmit\(s, "permission_resolved"/);
  assert.match(HOOK, /case "permission_resolved":/);
});

// ── Session lifecycle ──

test("a live session is never torn down by a create with a different cwd", () => {
  assert.match(
    DAEMON,
    /if \(aiSessions\.has\(sessionId\)\) \{\s*return \{ success: true, session: aiSessions\.get\(sessionId\) \};/
  );
});

test("only a non-zero pre-init exit is treated as a rejected resume id", () => {
  assert.match(DAEMON, /let initializedThisSpawn = false;/);
  // The CLI emits no `init` until the first prompt (verified against the real
  // binary), so a clean pre-init exit proves nothing and must keep the id.
  assert.match(DAEMON, /if \(s\.cliSessionId && !initializedThisSpawn && code !== 0\) \{/);
  assert.match(DAEMON, /proc\.on\("close", \(code\) => \{/);
});

test("stale process handlers stand down instead of clobbering the new process", () => {
  assert.match(DAEMON, /const isCurrent = \(\) => s\.proc === proc;/);
  assert.match(DAEMON, /s\.rl\.on\("line", \(line\) => \{\s*if \(!isCurrent\(\) \|\| !line\.trim\(\)\) return;/);
  assert.match(DAEMON, /proc\.on\("close", \(code\) => \{\s*if \(!isCurrent\(\)\) return;/);
  assert.match(DAEMON, /proc\.on\("error", \(err\) => \{\s*if \(!isCurrent\(\)\) return;/);
});

test("an idle process that dies before init reports why", () => {
  assert.match(DAEMON, /let stderrTail = "";/);
  assert.match(DAEMON, /aiEmit\(s, "error", \{ message: why\.slice\(-600\) \}\)/);
});

test("Stop interrupts the turn instead of killing the CLI process", () => {
  assert.match(DAEMON, /function sendInterrupt\(s\)/);
  assert.match(DAEMON, /subtype: "interrupt", cancel_queued: true/);
  assert.match(DAEMON, /const sent = sendInterrupt\(stopSession\);/);
  // SIGINT is only the fallback when the control request could not be written
  assert.match(DAEMON, /if \(!sent\) \{ try \{ stopSession\.proc\?\.kill\("SIGINT"\); \} catch \{\} \}/);
});

test("daemon shutdown takes the claude children with it", () => {
  assert.match(DAEMON, /try \{ s\.proc\?\.kill\("SIGINT"\); \} catch \{\}\s*try \{ s\.rl\?\.close\(\); \} catch \{\}\s*try \{\s*fs\.writeFileSync\(aiSnapshotFile\(id\)/);
});

test("a mid-turn mode/model change is deferred, not dropped", () => {
  assert.match(DAEMON, /optSession\.restartPending = true;/);
  assert.match(DAEMON, /if \(s\.restartPending\) \{\s*s\.restartPending = false;\s*spawnClaude\(s\);\s*\}/);
});

// ── Persistence ──

test("streaming persists are async, shutdown flush is sync", () => {
  assert.match(DAEMON, /function persistAiSessionNow[\s\S]{0,1400}?fs\.writeFile\(aiSnapshotFile/);
  assert.match(DAEMON, /fs\.writeFileSync\(aiSnapshotFile\(id\)/);
});

test("an in-flight write cannot resurrect a destroyed session's snapshot", () => {
  assert.match(DAEMON, /if \(!current\) \{\s*try \{ fs\.unlink\(aiSnapshotFile\(sessionId\)/);
  // ...but a *new* session of the same id owns its own file — leave it alone
  assert.match(DAEMON, /if \(current !== s\) return;/);
});

test("a completed turn is flushed immediately, not left in the debounce window", () => {
  assert.match(DAEMON, /function flushAiSession\(sessionId\)/);
  assert.match(DAEMON, /aiEmit\(s, "turn_complete"[\s\S]{0,220}?flushAiSession\(s\.id\)/);
  // the user's own message too — losing what was asked is the worst case.
  // Anchored on the OUTBOUND payload shape; handleClaudeLine reads an inbound
  // `type === "user"` earlier in the file and would otherwise match first.
  assert.match(DAEMON, /message: \{ role: "user", content: \[\{ type: "text", text: message \}\] \}[\s\S]{0,240}?flushAiSession\(sessionId\)/);
});

test("tool output is capped before it enters the re-serialized log", () => {
  assert.match(DAEMON, /const AI_MAX_TOOL_OUTPUT = \d+ \* 1024;/);
  assert.match(DAEMON, /if \(event === "tool_result"\) data = capToolOutput\(data\);/);
});

test("a rebuild-from-host reset also clears the derived task checklist", () => {
  const STORE = fs.readFileSync(path.join(root, "web/shared/stores/aiStore.js"), "utf8");
  // tasks are re-derived from the replayed TaskCreate/TaskUpdate events, so a
  // leftover list would double every entry
  assert.match(STORE, /messages: \[\],\s*tasks: \[\],\s*isTurnRunning: false/);
});

// ── Reducer coverage ──

test("the web reducer handles every event the daemon emits", () => {
  // `s` is the common session var; options_changed emits on optSession
  const emitted = [...new Set([
    ...[...DAEMON.matchAll(/aiEmit\(s, "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...DAEMON.matchAll(/aiEmit\(optSession, "([a-z_]+)"/g)].map((m) => m[1]),
  ])];
  assert.ok(emitted.length >= 10, `expected several events, saw ${emitted.length}`);
  const unhandled = emitted.filter((e) => !HOOK.includes(`case "${e}":`));
  // ansi is intentionally terminal-only chrome, not chat content
  assert.deepStrictEqual(unhandled.filter((e) => e !== "ansi"), []);
});

// ── Hydration race ──

test("live events racing the snapshot ack are held, not applied and wiped", () => {
  assert.match(HOOK, /if \(hydratingRef\.current\) \{\s*pendingLiveRef\.current\.push\(payload\);/);
  assert.match(HOOK, /const releaseHeld = \(\) => \{/);
  // The drain runs in the finally, so it happens whatever the ack carried
  assert.match(HOOK, /\} finally \{[\s\S]{0,140}?if \(gen === hydrateSeqRef\.current\) releaseHeld\(\);/);
});

test("host permission mode is applied on hydrate and on other clients' changes", () => {
  assert.match(DAEMON, /permissionMode: s\.permissionMode,/);
  assert.match(HOOK, /setPermissionMode\(sessionId, res\.session\.permissionMode\)/);
  assert.match(DAEMON, /aiEmit\(optSession, "options_changed"/);
  assert.match(HOOK, /case "options_changed":/);
});

// A resume/clear starts a NEW host log whose seqs begin at 1. Leaving the old
// watermark in place would drop every replayed event as "already applied", so the
// pane would come back empty after a /resume.
test("a reset clears the seq watermark before the new log replays", () => {
  assert.match(HOOK, /if \(payload\.event === "conversation_reset"\) \{\s*appliedSeqRef\.current = 0;/);
  // The held-event drain needs the same rule
  assert.match(HOOK, /if \(p\.event === "conversation_reset"\) \{\s*appliedSeqRef\.current = 0;/);
  // The hydrate watermark must follow the snapshot, not stay at the old maximum
  assert.match(HOOK, /appliedSeqRef\.current = snapshotSeq;/);
  assert.doesNotMatch(HOOK, /appliedSeqRef\.current = Math\.max\(appliedSeqRef\.current, snapshotSeq\)/);
});

test("a resume rebinds the daemon session and replays the new transcript", () => {
  assert.match(DAEMON, /CLAUDE_SESSION_ID_RE\.test\(resume\)/);
  assert.match(DAEMON, /optSession\.cliSessionId = resume;/);
  assert.match(DAEMON, /recoverFromClaudeTranscript\(optSession\.cwd, resume\)/);
  assert.match(DAEMON, /broadcastAiEvent\(sessionId, "conversation_reset", \{\}\);/);
});

// codex/opencode run on the in-agent path, so their resume has to rebuild the log
// from their own stores — otherwise the pane comes back empty after a resume.
test("codex and opencode resume rebuild their history from the CLI store", () => {
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  const TRANSCRIPT = fs.readFileSync(path.join(root, "agent/features/ai/transcript.js"), "utf8");
  assert.match(SESSION, /recoverFromTranscript\(this\.engine, this\.cwd, resume\)/);
  assert.match(SESSION, /this\.history = recovered \|\| \[\]/);
  assert.match(TRANSCRIPT, /export function recoverFromCodexTranscript/);
  assert.match(TRANSCRIPT, /export function recoverFromOpencodeTranscript/);
  // A resumed log starts at seq 1, so it cannot inherit the previous watermark
  assert.match(TRANSCRIPT, /return slice\.map\(\(e, i\) => \(\{ \.\.\.e, seq: i \+ 1 \}\)\)/);
  // Codex/opencode write harness turns (environment block, aborted-turn note) as if
  // the user typed them. Replaying one opens a bubble that never closes, so they are
  // filtered. Asserted via the shared helper both readers call.
  assert.match(TRANSCRIPT, /const HARNESS_TURN_RE = \/\^\\s\*<\(environment_context\|turn_aborted\)>/);
  assert.match(TRANSCRIPT, /if \(isHarnessTurn\(text\)\) continue;/);
  assert.match(TRANSCRIPT, /if \(isHarnessTurn\(pd\.text\)\) continue;/);
  // A codex rollout is matched by its exact filename tail, never a substring
  assert.match(TRANSCRIPT, /const suffix = `-\$\{sessionId\}\.jsonl`/);
  assert.match(TRANSCRIPT, /if \(!name\.endsWith\(suffix\)\) continue;/);
  // opencode sessions are scoped to the directory they ran in
  assert.match(TRANSCRIPT, /session\.directory && path\.resolve\(session\.directory\) !== path\.resolve\(cwd\)/);
});

test("codex resume does not pass -s, which `codex exec resume` rejects", () => {
  const CODEX = fs.readFileSync(path.join(root, "agent/features/ai/adapters/codexAdapter.js"), "utf8");
  const resumeBranch = CODEX.slice(CODEX.indexOf('args.push("resume", "--json")'), CODEX.indexOf("} else {"));
  assert.doesNotMatch(resumeBranch, /args\.push\("-s"/);
  // The sandbox policy goes through a config override on the resume path instead
  assert.match(resumeBranch, /-c", `sandbox_mode=/);
});

test("a client-supplied resume id cannot escape the projects dir or argv", () => {
  const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
  for (const bad of ["--dangerously-bypass-approvals-and-sandbox", "-s", "../../etc/passwd", "a/b", "a b", ""]) {
    assert.equal(ID_RE.test(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ["01a090c7-4f5f-7722-ab9d-596d795b2d29", "ses_2f9a1b", "abc"]) {
    assert.equal(ID_RE.test(ok), true, `must accept ${ok}`);
  }
  // Both the daemon and the in-agent path validate before using the id
  assert.match(DAEMON, /const CLAUDE_SESSION_ID_RE = \/\^\[A-Za-z0-9_\]/);
  assert.match(fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8"), /const RESUME_ID_RE = \/\^\[A-Za-z0-9_\]/);
});

test("the transcript read is confined to the projects directory", () => {
  assert.match(DAEMON, /const resolved = path\.resolve\(p\);/);
  assert.match(DAEMON, /if \(!resolved\.startsWith\(path\.resolve\(projectsDir\) \+ path\.sep\)\) return null;/);
});

test("a lost ack cannot leave the hydrate gate shut forever", () => {
  assert.match(HOOK, /HYDRATE_TIMEOUT_MS = \d+/);
  assert.match(HOOK, /const releaseTimer = setTimeout\(\(\) => \{/);
});

test("a stale hydrate cycle stands down (StrictMode double-mount)", () => {
  assert.match(HOOK, /const gen = \+\+hydrateSeqRef\.current;/);
  assert.match(HOOK, /if \(gen !== hydrateSeqRef\.current\) return;/);
});

test("sending a prompt does not re-ship the whole event log", () => {
  // ai:create must be emitted only by the mount effect, never per prompt
  const emits = [...HOOK.matchAll(/emit\(\s*"ai:create"/g)].length;
  assert.equal(emits, 1, `expected exactly one ai:create emit, found ${emits}`);
});

// ── Routing ──

test("mock (test) sessions stay on the in-agent path, never the daemon", () => {
  assert.match(SOCKET, /function aiUsesDaemon\(engine, mock = false\)/);
  assert.match(SOCKET, /aiUsesDaemon\(engine, mock\)/);
});

test("prompt auto-create carries the cwd end to end", () => {
  assert.match(HOOK, /b\?\.emit\("ai:prompt", \{ sessionId, message: text, cwd: workspacePath \}\)/);
  assert.match(SOCKET, /daemonClient\.aiPrompt\(sessionId, message, cwd \|\| null\)/);
  assert.match(DAEMON, /function aiPrompt\(sessionId, message, cwd = null\)/);
  assert.match(DAEMON, /createAiSession\(sessionId, \{ engine: "claude", cwd, options: \{\} \}\)/);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
