// What a chat snapshot must carry, and — the point of this file — what it must NOT.
//
// The snapshot is not a copy of the conversation. The CLI already writes that to its own
// transcript, and `AiSession` rebuilds the log from it on every open (`_rebuildFromStore`).
// What the snapshot holds is the state the transcript has nowhere to put: the daemon
// line watermark, the user's picks, and the harness records the CLI never writes down.
//
// Measured on a real 7.19 MB snapshot: 4.25 MB of it was `cli_event` — attachment and
// system records the transcript already contains — against 2 KB of `task_*` records that
// it does not. This file pins that split so the bytes cannot creep back.
//
// Run: node agent/test/aiSnapshotMinimal.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Relocate the agent's root BEFORE importing anything that computes PATHS from it —
// otherwise this test writes its sessions into the live ~/.9remote (which is how 983
// stray `claude-span-*` snapshots got there). HOME moves too: the CLI transcript lives
// under `os.homedir()/.claude/projects`, which follows HOME and not NREMOTE_HOME.
// ORIGINAL_HOME is kept so the census below can still read the machine's real history.
const ORIGINAL_HOME = os.homedir();
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-snapmin-"));
process.env.NREMOTE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { AiSession } = await import("../features/ai/aiSession.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const SNAP_DIR = path.join(HOME, "ai-sessions");
// One transcript at a time, and one cwd for all of them: `findTranscript` searches by id
// across the WHOLE projects dir, so a second file with the same id left by an earlier test
// would be found first and every count below would measure the wrong conversation.
const TRANSCRIPT_CWD = "/tmp/snapmin-replay";
const PROJECTS = path.join(HOME, ".claude", "projects");

let seq = 0;
const makeSession = () =>
  new AiSession({ id: `snapmin-${++seq}`, engine: "claude", cwd: TRANSCRIPT_CWD, options: { mock: true } });

const snapshotOf = (s) => {
  s.flushSaveSnapshot();
  return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `claude-${s.id}.json`), "utf8"));
};

// The two record shapes the CLI writes to its OWN transcript, so the snapshot need not.
const attachment = (type, extra = {}) => ({
  event: "cli_event",
  data: { type: "attachment", subtype: type, record: { type: "attachment", attachment: { type, ...extra } } }
});
const systemRecord = (subtype, extra = {}) => ({
  event: "cli_event",
  data: { type: "system", subtype, record: { type: "system", subtype, ...extra } }
});

console.log("Running AI snapshot minimality tests...");

// ── the state the transcript cannot carry: all of it must survive ──

test("the daemon watermark survives — it is what makes a re-attach resume, not replay", () => {
  const s = makeSession();
  s.consumedLines = 4821;
  s.consumedEpoch = "epoch-7";
  const snap = snapshotOf(s);
  assert.equal(snap.consumedLines, 4821, "the line watermark is the reason the snapshot exists");
  assert.equal(snap.consumedEpoch, "epoch-7", "line numbers belong to a process, so the epoch rides along");
});

test("the user's picks survive, or a reload silently reverts them", () => {
  const s = makeSession();
  s.model = "claude-opus-5";
  s.effort = "xhigh";
  s.permissionMode = "acceptEdits";
  const snap = snapshotOf(s);
  assert.equal(snap.model, "claude-opus-5");
  assert.equal(snap.effort, "xhigh");
  assert.equal(snap.permissionMode, "acceptEdits");
});

test("the conversation id survives — without it a restart cannot find the transcript", () => {
  const s = makeSession();
  s.cliSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(snapshotOf(s).cliSessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

// ── the log is NOT here. This is the rule the file exists to keep ──
//
// Measured on a real 7.19 MB chat: the conversation the snapshot held was thrown away on
// the next open anyway (`_rebuildFromStore` replaces it), and an in-flight turn comes back
// from the daemon's ring. Storing either bought nothing and cost megabytes per debounce.

const LOG_EVENTS = [
  ["user_message", { text: "hi" }],
  ["delta", { text: "hello" }],
  ["thinking", { text: "hmm" }],
  ["tool_start", { id: "c1", name: "Bash", input: { command: "ls" } }],
  ["tool_result", { id: "c1", name: "Bash", output: "a", status: "done" }],
  ["diff", { file: "/w/a.js", patch: "@@" }],
  ["turn_complete", { stats: {} }]
];

test("no conversation event is written down, whatever it is", () => {
  const s = makeSession();
  for (const [event, data] of LOG_EVENTS) s.emitNormalized(event, data);
  const snap = snapshotOf(s);
  assert.equal(snap.events, undefined, "the file carries no log at all");
});

test("a task record is not written down either — the ring still has it, and the rebuild carries it", () => {
  // The one cli_event the transcript lacks. It lives in `history` (so a rebuild carries it
  // across) and rides the connect state (`taskRecords`), not this file.
  const s = makeSession();
  s.emitNormalized("cli_event", {
    type: "system", subtype: "task_started",
    record: { type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "c1", is_backgrounded: true }
  });
  assert.equal(snapshotOf(s).events, undefined);
  assert.ok(
    s.history.some((e) => e.event === "cli_event" && e.data?.subtype === "task_started"),
    "but it IS in the live log, for the rebuild to carry"
  );
});

test("the CLI's chatter never reaches the disk", () => {
  const s = makeSession();
  for (const [event, data] of LOG_EVENTS) s.emitNormalized(event, data);
  // What a real session accumulates: 94 edited-file attachments carrying the whole file,
  // plus a hook record per tool call.
  for (let i = 0; i < 94; i++) {
    s.history.push(attachment("edited_text_file", { filename: `/w/f${i}.js`, snippet: "z".repeat(8000) }));
    s.history.push(systemRecord("hook_success", { hookEvent: "PostToolUse", content: "w".repeat(2000) }));
  }
  const snap = snapshotOf(s);
  const bytes = fs.statSync(path.join(SNAP_DIR, `claude-${s.id}.json`)).size;
  assert.ok(bytes < 2000, `a state-only snapshot must be tiny, got ${bytes} bytes`);
  assert.ok(!JSON.stringify(snap).includes("z".repeat(100)), "no file body, no hook dump");
});

test("the file is state and nothing else — the exact set it may carry", () => {
  const s = makeSession();
  for (const [event, data] of LOG_EVENTS) s.emitNormalized(event, data);
  const keys = Object.keys(snapshotOf(s)).sort();
  assert.deepEqual(keys, [
    "attachmentOffset", "cliSessionId", "consumedEpoch", "consumedLines", "createdAt",
    "cwd", "effort", "engine", "model", "permissionMode", "threadId"
  ].sort(), "a field added here without a reason is a megabyte waiting to happen");
});

// ── the property the whole slimming rests on: the TUI harness is still the source ──
//
// A snapshot drops a record ONLY because the CLI's own transcript can hand it back. That
// claim is what this section tests, end to end: write a real transcript file, read it the
// way a reopened chat does, and assert the records the pane DRAWS are all still there.
//
// If any of these ever fails, the slimming is wrong and the record must go back into the
// snapshot — not the test be adjusted.

const { recoverFromClaudeTranscript } = await import("../features/ai/claudeTranscript.js");

const CLAUDE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// One transcript at a time, and a fixed cwd: `findTranscript` searches by id across the
// WHOLE projects dir, so a second file with the same id from an earlier test would be
// found first and every count below would be measuring the wrong conversation.

/** Replace the transcript store with exactly one conversation, and return its events. */
function replayTranscript(lines) {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  const dir = path.join(PROJECTS, TRANSCRIPT_CWD.replace(/[/\\:]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${CLAUDE_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  return recoverFromClaudeTranscript(TRANSCRIPT_CWD, CLAUDE_ID) || [];
}

// Every kind `noticeFrom` renders — checked against the reader that decides it.
const RENDERED_SYSTEM = ["api_error", "local_command", "compact_boundary", "informational", "away_summary", "model_refusal_fallback"];
const RENDERED_ATTACHMENT = ["edited_text_file", "queued_command"];

test("every record the pane draws comes back from the CLI's transcript", () => {
  const lines = [
    { type: "user", message: { content: [{ type: "text", text: "go" }] } },
    ...RENDERED_ATTACHMENT.map((t) => ({
      type: "attachment",
      attachment: t === "edited_text_file"
        ? { type: t, filename: "/w/a.js", snippet: "the whole file" }
        : { type: t, prompt: "a queued prompt" }
    })),
    ...RENDERED_SYSTEM.map((st) => ({ type: "system", subtype: st, level: "info", content: `a ${st} line` })),
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } }
  ];
  const events = replayTranscript(lines);
  const seen = events.filter((e) => e.event === "cli_event")
    .map((e) => e.data.subtype);
  for (const t of [...RENDERED_ATTACHMENT, ...RENDERED_SYSTEM]) {
    assert.ok(seen.includes(t), `${t} is drawn by the pane and must survive a reopen`);
  }
});

test("a session-start hook line is not lost either — it is the one hook the pane shows", () => {
  // noticeFrom renders hook_success ONLY for SessionStart; every other hook feeds the
  // model, not the reader. The reader must still carry the record for the pane to judge.
  const events = replayTranscript([
    { type: "attachment", attachment: { type: "hook_success", hookEvent: "SessionStart", content: "hook ran" } }
  ]);
  const hook = events.find((e) => e.event === "cli_event" && e.data.subtype === "hook_success");
  assert.ok(hook, "the hook record reaches the pane, which decides whether to draw it");
  assert.equal(hook.data.record.attachment.hookEvent, "SessionStart");
});

test("an edited file's body is stripped on the way back, so the row shows a name", () => {
  // The row is the filename; the whole-file snippet is 8KB the pane never reads.
  const events = replayTranscript([
    { type: "attachment", attachment: { type: "edited_text_file", filename: "/w/a.js", snippet: "x".repeat(8000) } }
  ]);
  const rec = events.find((e) => e.event === "cli_event").data.record;
  assert.equal(rec.attachment.filename, "/w/a.js");
  assert.equal(rec.attachment.snippet, undefined, "the body belongs to the file, not the row");
});

test("the task record is the ONE thing that must come from the snapshot, not the transcript", () => {
  // The claim the whole slimming rests on is empirical, not structural: the reader WILL
  // forward a task record if the transcript holds one (the branch above proves that), so
  // the snapshot only needs it because the CLI never writes it down. Measured here over
  // the real transcripts on this machine rather than asserted from a fixture — a fixture
  // would only be testing my own file.
  //
  // Skips when there is no CLI history to scan (a clean machine, CI).
  const realHome = ORIGINAL_HOME;
  const projectsDir = path.join(realHome, ".claude", "projects");
  const files = fs.existsSync(projectsDir)
    ? fs.readdirSync(projectsDir).flatMap((d) => {
        const sub = path.join(projectsDir, d);
        try { return fs.statSync(sub).isDirectory() ? fs.readdirSync(sub).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(sub, f)) : []; }
        catch { return []; }
      })
    : [];
  if (!files.length) {
    console.log("      (skipped — no CLI transcripts on this machine to measure)");
    return;
  }
  let wrote = 0;
  let scanned = 0;
  for (const f of files.slice(0, 400)) {
    scanned++;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      // Cheap substring gate first: these files run to megabytes.
      if (!line.includes('"task_started"') && !line.includes('"background_tasks_changed"')) continue;
      try { if (JSON.parse(line).type === "system") wrote++; } catch {}
    }
  }
  assert.equal(wrote, 0, `the CLI wrote ${wrote} task records across ${scanned} transcripts — the snapshot may no longer need them`);
});

// ── the offset must move with the conversation it indexes ──
//
// A byte offset into ONE transcript file. Carried across a conversation change it points
// into a file that is not this conversation's — the reader then either reads garbage from
// mid-record or, seeing a shorter file, resets to 0 and replays a whole history the pane
// already drew. The field is newly persisted, so this is newly reachable.

test("clearing the conversation drops the offset that indexed it", () => {
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  s.attachmentOffset = 999_999;
  s.sendPrompt("/clear");
  assert.equal(s.cliSessionId, null, "the conversation is gone");
  assert.equal(s.attachmentOffset, null, "so is the offset into its transcript");
});

test("resuming another conversation drops the offset too", () => {
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  s.attachmentOffset = 999_999;
  // A resume to a conversation with no transcript on disk: the rebuild finds nothing,
  // which is exactly the case where the stale offset would survive unnoticed.
  s.setOptions({ resume: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
  assert.equal(s.cliSessionId, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
  assert.equal(s.attachmentOffset, null, "the old file's offset must not follow the new conversation");
});

// ── the round trip: what the snapshot held must be there after a restart ──
//
// The bug this section exists for: the constructor read the snapshot and then REPLACED
// the whole log with the transcript rebuild. `_adoptLog` carries the harness records
// across a rebuild; the constructor never calls it, so every cli_event the snapshot had
// was thrown away — including the task record the snapshot is kept for. The agent strip
// came back empty over work that was still running.

test("a task record the rebuild cannot produce is carried across it, not resurrected from disk", () => {
  // The task set is what the agent strip reads. It cannot come from the snapshot (the file
  // holds no log) and cannot come from the transcript (0 of 1007 real ones carry it) — so
  // it survives a rebuild by being CARRIED, which is what `_adoptLog` and the constructor
  // both do. This is the live path: a log already holding the record gets rebuilt.
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  replayTranscript([{ type: "user", message: { content: [{ type: "text", text: "go" }] } }]);
  s.emitNormalized("cli_event", {
    type: "system", subtype: "task_started",
    record: { type: "system", subtype: "task_started", task_id: "t-1", tool_use_id: "c1", is_backgrounded: true }
  });
  s.refreshFromStore();
  const tasks = s.history.filter((e) => e.event === "cli_event");
  assert.equal(tasks.length, 1, "the rebuild must carry it — dropping it empties the strip mid-task");
  assert.equal(tasks[0].data.subtype, "task_started");
});

test("the watermark is what a revived session resumes from, so it must come back too", () => {
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  s.consumedLines = 4242;
  s.consumedEpoch = "epoch-9";
  s.flushSaveSnapshot();
  const revived = new AiSession({ id: s.id, engine: "claude", cwd: s.cwd, options: { mock: true } });
  assert.equal(revived.consumedLines, 4242, "without this a re-attach replay would double the turn");
  assert.equal(revived.consumedEpoch, "epoch-9");
});

// ── a rebuild must not draw the same record twice ──
//
// The transcript DOES hold some records the pane renders (api_error, queued_command,
// edited_text_file — measured in the real files). Carrying those across a rebuild while
// the rebuild also produces them put two identical rows on screen.

test("a record both sources know is not drawn twice after a rebuild", () => {
  const lines = [{ type: "system", subtype: "api_error", level: "error", content: "boom" }];
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  replayTranscript(lines);
  s.emitNormalized("cli_event", {
    type: "system", subtype: "api_error",
    record: { type: "system", subtype: "api_error", level: "error", content: "boom" }
  });
  assert.equal(s.history.filter((e) => e.event === "cli_event").length, 1, "one record was emitted");
  s.refreshFromStore();
  const after = s.history.filter((e) => e.event === "cli_event");
  assert.equal(after.length, 1, `a rebuild must not duplicate it — got ${after.length}`);
});

test("an init that names a DIFFERENT conversation drops the offset with it", () => {
  // The adapter announces the CLI's own session id on init, and on a first spawn that is
  // the moment the id becomes known. If it ever names a different one — a respawn that
  // picked up another conversation — the offset indexes a file this is no longer reading,
  // and a longer file would let it land mid-record.
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  s.attachmentOffset = 15_000;
  s.emitNormalized("init", { sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
  assert.equal(s.cliSessionId, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
  assert.equal(s.attachmentOffset, null, "the new conversation seeds its own offset");
});

test("an init that repeats the SAME id keeps the offset — that is a plain reattach", () => {
  // The common case, and it must not be broken by the guard above: an agent that comes
  // back to a running CLI replays the same init, and the offset is exactly what lets the
  // attachment read resume instead of replaying the conversation's whole history.
  const s = makeSession();
  s.cliSessionId = CLAUDE_ID;
  s.attachmentOffset = 15_000;
  s.emitNormalized("init", { sessionId: CLAUDE_ID });
  assert.equal(s.attachmentOffset, 15_000, "same conversation, same file, same offset");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
