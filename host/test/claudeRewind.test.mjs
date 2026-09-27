// The claude rewind points: which records in a transcript are turns the user typed, and
// how a position from the end of the pane's log resolves to one of them.
//
// Run: node agent/test/claudeRewind.test.mjs
//
// These run against a synthetic transcript rather than a real session: the filter is the
// part that can be wrong (every record type shares one file), and a real session takes
// minutes to build and leaves a conversation behind. The rewind itself is a control
// request now, not a cut of this file — measured end to end in
// agent/test/spike-controlRewind.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRewindPoints } from "../features/ai/claudeRewind.js";
import { resolveRewindTarget } from "../features/ai/rewind.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const SESSION_ID = "99999999-1111-2222-3333-444444444444";
const PROJECT_DIR = "-private-tmp-rw-test";
// Own projects tree: the real one holds every conversation the user ever had, and a
// stray test id would resolve against it instead of these fixtures.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-rewind-"));
process.env.NREMOTE_CLAUDE_PROJECTS_DIR = tmpRoot;
const root = path.join(tmpRoot, PROJECT_DIR);
const transcript = path.join(root, `${SESSION_ID}.jsonl`);

const line = (o) => JSON.stringify(o);

// One record of each shape the parser has to tell apart.
const RECORDS = [
  line({ type: "mode", mode: "normal", sessionId: SESSION_ID }),
  line({ type: "user", uuid: "u1", isSidechain: false, timestamp: "2026-09-13T10:00:00Z",
    message: { role: "user", content: "first question" } }),
  line({ type: "file-history-snapshot", messageId: "u1",
    snapshot: { messageId: "u1", trackedFileBackups: {}, timestamp: "2026-09-13T10:00:01Z" } }),
  line({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
  // A tool result is stored as a user record — it must NOT become a rewind point.
  line({ type: "user", uuid: "tr1", isSidechain: false,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  line({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "wrote them" }] } }),
  // Order and shape as the CLI writes them under the SDK entrypoint: a `file-history-delta`
  // per write, naming the turn that made it. u1 wrote a.js, u2 wrote b.js.
  line({ type: "file-history-delta", messageId: "d1", snapshotMessageId: "u1", trackingPath: "src/a.js",
    backup: { backupFileName: "aaaa1111@v2", version: 2, realParentDir: "/tmp/rw-test/src" },
    timestamp: "2026-09-13T10:01:30Z" }),
  line({ type: "user", uuid: "u2", isSidechain: false, timestamp: "2026-09-13T10:02:00Z",
    message: { role: "user", content: "second question" } }),
  line({ type: "file-history-snapshot", messageId: "u2",
    snapshot: { messageId: "u2", timestamp: "2026-09-13T10:02:01Z",
      trackedFileBackups: {
        "src/a.js": { backupFileName: "aaaa1111@v2", version: 2, realParentDir: "/tmp/rw-test/src" }
      } } }),
  line({ type: "file-history-delta", messageId: "d2", snapshotMessageId: "u2", trackingPath: "src/b.js",
    backup: { backupFileName: "bbbb2222@v1", version: 1, realParentDir: "/tmp/rw-test/src" },
    timestamp: "2026-09-13T10:02:02Z" }),
  // Sidechain (sub-agent) turns are not turns the user asked for.
  line({ type: "user", uuid: "sc1", isSidechain: true, message: { role: "user", content: "sub agent prompt" } }),
  // The CLI writes its own messages into the transcript under the user role: a skill's
  // body, a slash command's output, a background task reporting back. They are not turns,
  // and the CLI refuses to rewind to one ("No file checkpoint found for this message"),
  // which fails the whole rewind — so they must not be counted.
  line({ type: "user", uuid: "sk1", isMeta: true, turnCompanion: true,
    message: { role: "user", content: [{ type: "text", text: "# Workflow authoring reference\n\nA workflow structures work" }] } }),
  line({ type: "user", uuid: "cn1", isMeta: true, turnCompanion: true,
    message: { role: "user", content: "<command-name>/rewind</command-name>\n<command-message>rewind</command-message>" } }),
  line({ type: "user", uuid: "tn1", origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>" } }),
];

fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(transcript, RECORDS.join("\n") + "\n");

// Awaited one by one: the runner is async and the finally below would otherwise
// clear the fixture tree while the later tests are still reading it.
try {
  await test("only real user turns become rewind points", () => {
    const points = listRewindPoints(SESSION_ID);
    assert.deepEqual(points.map((p) => p.messageId), ["u1", "u2"]);
  });

  await test("a point carries the prompt text", () => {
    const [first] = listRewindPoints(SESSION_ID);
    assert.equal(first.text, "first question");
    assert.equal(first.createdAt, "2026-09-13T10:00:00Z");
  });

  await test("a tool result is not offered as a turn to rewind to", () => {
    const ids = listRewindPoints(SESSION_ID).map((p) => p.messageId);
    assert.ok(!ids.includes("tr1"));
  });

  await test("a sub-agent turn is not offered either", () => {
    const ids = listRewindPoints(SESSION_ID).map((p) => p.messageId);
    assert.ok(!ids.includes("sc1"));
  });

  // Verified against the CLI: `--rewind-files <one of these>` answers "No file checkpoint
  // found for this message" and restores nothing, and applyRewind returns that failure
  // BEFORE cutting — so the pane looked like it did nothing at all.
  await test("a record the CLI wrote itself is not a turn to rewind to", () => {
    const ids = listRewindPoints(SESSION_ID).map((p) => p.messageId);
    for (const injected of ["sk1", "cn1", "tn1"]) assert.ok(!ids.includes(injected), injected);
  });

  // The pane counts turns from the end of what it renders, so an injected record counted
  // as a turn would aim every index below it one turn too far down.
  await test("an injected record does not shift the turn count", () => {
    const points = listRewindPoints(SESSION_ID);
    assert.deepEqual(points.map((p) => p.messageId), ["u1", "u2"]);
    assert.equal(resolveRewindTarget(points, 0), "u2");
  });

  // What a rewind would restore is the CLI's answer for the turn actually picked
  // (`rewind_files` with dry_run), not a reading of this file — so a point carries no
  // file list at all, and nothing here guesses one.
  await test("a point carries no file list of its own", () => {
    for (const p of listRewindPoints(SESSION_ID)) assert.equal(p.files, undefined);
  });

  await test("an unknown session id yields no points rather than throwing", () => {
    assert.deepEqual(listRewindPoints("11111111-2222-3333-4444-555555555555"), []);
  });

  await test("a malformed session id is refused (it becomes argv)", () => {
    assert.deepEqual(listRewindPoints("../../etc/passwd"), []);
    assert.deepEqual(listRewindPoints("-rf"), []);
  });

  // What the edit button sends. The pane counts turns from the end of what IT is showing,
  // and the host resolves that against the CLI's own list — so the two must agree on the
  // same conversation, including on which records count as a turn at all.
  await test("a position from the end resolves to the same list the pane counted", () => {
    const points = listRewindPoints(SESSION_ID);
    // Newest is 0: the tail is the part the pane and the transcript always share.
    assert.equal(resolveRewindTarget(points, 0), "u2");
    assert.equal(resolveRewindTarget(points, 1), "u1");
    // Past the oldest turn there is nothing to name, and the host must refuse rather
    // than clamp onto a neighbour. A sub-agent turn is not a turn here either — if the
    // pane counted it, every index below it would be off by one.
    assert.equal(resolveRewindTarget(points, 2), undefined);
    assert.equal(points.length, 2);
  });

  // Reading a transcript must not change it: the rewind is the CLI's job now, and a
  // reader that rewrites the file would be the old cut creeping back in.
  await test("listing points leaves the transcript untouched", () => {
    const before = fs.readFileSync(transcript, "utf8");
    listRewindPoints(SESSION_ID);
    assert.equal(fs.readFileSync(transcript, "utf8"), before);
  });
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
