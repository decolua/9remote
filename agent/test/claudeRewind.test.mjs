// The claude rewind path: reading a transcript for its user-turn uuids, and resolving
// which files a rewind to one of those turns would put back.
//
// Run: node agent/test/claudeRewind.test.mjs
//
// These run against a synthetic transcript rather than a real session: the parser is
// the part that can be wrong (every record type shares one file), and a real session
// takes minutes to build and leaves a conversation behind. The two CLI flags themselves
// are exercised by the spike that established them — see the header of claudeRewind.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRewindPoints, previewRewind, rewindTarget } from "../features/ai/claudeRewind.js";

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
  // The CLI labels a checkpoint with the turn it PRECEDES, so this one belongs to u2.
  line({ type: "file-history-snapshot", messageId: "u2",
    snapshot: { messageId: "u2", timestamp: "2026-09-13T10:01:00Z",
      trackedFileBackups: {
        "src/a.js": { backupFileName: "aaaa1111@v2", version: 2, realParentDir: "/tmp/rw-test/src" },
        "src/b.js": { backupFileName: "bbbb2222@v1", version: 1, realParentDir: "/tmp/rw-test/src" }
      } } }),
  line({ type: "user", uuid: "u2", isSidechain: false, timestamp: "2026-09-13T10:02:00Z",
    message: { role: "user", content: "second question" } }),
  // Sidechain (sub-agent) turns are not turns the user asked for.
  line({ type: "user", uuid: "sc1", isSidechain: true, message: { role: "user", content: "sub agent prompt" } }),
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

  await test("a rewrite to the first turn restores nothing — no snapshot precedes it", () => {
    const [first] = listRewindPoints(SESSION_ID);
    assert.deepEqual(first.files, []);
  });

  await test("a rewind to a later turn names the files its snapshot tracked", () => {
    const second = listRewindPoints(SESSION_ID).find((p) => p.messageId === "u2");
    assert.deepEqual(second.files, ["aaaa1111@v2", "bbbb2222@v1"]);
  });

  await test("an unknown session id yields no points rather than throwing", () => {
    assert.deepEqual(listRewindPoints("11111111-2222-3333-4444-555555555555"), []);
  });

  await test("a malformed session id is refused (it becomes argv)", () => {
    assert.deepEqual(listRewindPoints("../../etc/passwd"), []);
    assert.deepEqual(listRewindPoints("-rf"), []);
  });

  await test("preview names the files and warns about untracked writes", async () => {
    const p = await previewRewind(SESSION_ID, "u2", { files: true });
    assert.equal(p.ok, true);
    assert.deepEqual(p.files, ["aaaa1111@v2", "bbbb2222@v1"]);
    assert.equal(p.filesUnknown, false);
    assert.match(p.note, /shell command/i);
  });

  await test("preview without files still reports ok", async () => {
    const p = await previewRewind(SESSION_ID, "u2", { files: false });
    assert.deepEqual(p.files, []);
  });

  // An empty list must not read as "nothing will change": the CLI leaves the mapping
  // blank on a session it has not re-saved, while the backups are still on disk.
  await test("a preview that cannot name the files says so", async () => {
    const p = await previewRewind(SESSION_ID, "u1", { files: true });
    assert.deepEqual(p.files, []);
    assert.equal(p.filesUnknown, true);
    assert.match(p.note, /does not report which files/i);
  });
  // The CLI KEEPS the turn named by --resume-session-at and drops what follows, so a
  // rewind to a prompt has to keep the turn BEFORE it — passing the prompt's own uuid
  // would leave that prompt in the conversation.
  await test("a rewind keeps the turn before the target, not the target", () => {
    assert.equal(rewindTarget(SESSION_ID, "u2"), "u1");
  });

  // null (keep NOTHING) and undefined (unknown target) must not be conflated: the
  // first is a real rewind, the second is a refusal.
  await test("rewinding to the first turn keeps nothing", () => {
    assert.equal(rewindTarget(SESSION_ID, "u1"), null);
  });

  await test("an unknown target is refused, not treated as a rewind", () => {
    assert.equal(rewindTarget(SESSION_ID, "nope"), undefined);
  });
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
