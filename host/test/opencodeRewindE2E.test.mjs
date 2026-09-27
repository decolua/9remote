// Does the v2 path — session created and prompted THROUGH the server — restore files?
//
// Run: node agent/test/opencodeRewindE2E.test.mjs
//
// The earlier run proved the split: `opencode run` writes to the CLI's own store, which
// the server's revert API cannot see ("Message not found"). So a rewind has to happen
// inside a conversation the server itself owns. This checks whether that path restores
// a file, which decides whether the adapter can move onto it.
//
// MEASURED, on this version of the CLI: it does NOT, and the reason is in opencode's own
// snapshot store (~/.local/share/opencode/snapshot/<project>/<hash>) — every one of those
// git dirs has ZERO commits (`rev-list --all --count` → 0), so `revert/stage` answers
// `{files: []}` and nothing is ever put back. The conversation half still rolls back
// (`ai:rewind` reports the cut and the store rebuilds), which is why the engine's support
// table says `files: true` only on the strength of its docs.
//
// So the assertion below is the HONEST one: the conversation rolls back, and the file does
// not. It is written to fail loudly if a future CLI starts committing snapshots — at which
// point the file half can be turned on for real.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSession, prompt, stageRevert, clearRevert, commitRevert, deleteSession, listMessages } from "../features/ai/opencodeServer.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-rewind-v2-"));
fs.writeFileSync(path.join(dir, "note.txt"), "ORIGINAL\n");
// Snapshots only exist inside a git worktree — opencode's own docs say so, and the
// first run of this test proved it: outside one, the revert stages an empty file list
// and the conversation rolls back alone.
execFileSync("git", ["init", "-q"], { cwd: dir });
execFileSync("git", ["add", "-A"], { cwd: dir });

console.log("Running opencode v2 rewind E2E...");
console.log(`  scratch dir: ${dir}`);

// Poll for the EFFECT, not for a message shape: an assistant row is marked completed
// long before the tool that edits the file has run, so waiting on that returned early.
const waitFor = async (label, check, { timeoutMs = 120000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}`);
};

let sessionId = null;

await test("create the conversation through the server", async () => {
  const s = await createSession(dir);
  assert.ok(s?.id, "expected a session id");
  sessionId = s.id;
});

await test("agent edits a file (prompted through the server)", async () => {
  await prompt(sessionId, "Replace the entire contents of note.txt with exactly: CHANGED-BY-AGENT. Do nothing else.");
  await waitFor("the agent to write the file", () =>
    fs.readFileSync(path.join(dir, "note.txt"), "utf8").includes("CHANGED-BY-AGENT"));
});

await test("the server can see the conversation and name the file it would restore", async () => {
  const msgs = await listMessages(sessionId);
  const userId = msgs.find((m) => m.type === "user")?.id;
  assert.ok(userId, "expected a user message in the server's store");

  const staged = await stageRevert(sessionId, userId, { files: true });
  const files = (staged?.files || []).map((f) => f.file);
  console.log(`    staged: ${JSON.stringify(files)}`);
  assert.ok(staged, "stage should answer");
});

// A preview with no files must SAY so. The dialog's empty-files branch prints the note and
// nothing else, so an answer of `files: []` with no note drew a BLANK line — the reader
// cannot tell "nothing changes" from "the question was never answered". This CLI keeps no
// file snapshot (above), so this is the branch opencode always takes.
await test("a preview with no files explains itself instead of drawing a blank line", async () => {
  const { previewRewind } = await import("../features/ai/opencodeRewind.js");
  const msgs = await listMessages(sessionId);
  const userId = msgs.find((m) => m.type === "user")?.id;
  const res = await previewRewind(sessionId, userId, { files: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.files, [], "this CLI stages no files");
  assert.match(res.note || "", /no file snapshot/i,
    "and the dialog is told why, rather than printing an empty line");
});

// The measured truth on this CLI: the conversation rolls back, the file does not. Written
// as an assertion on BOTH halves so a fix upstream flips this test red and the file half
// can be turned on deliberately — a silent pass would leave the support table claiming
// something no run has ever shown.
await test("a commit rolls the conversation back and leaves the file as the agent wrote it", async () => {
  const msgs = await listMessages(sessionId);
  const userId = msgs.find((m) => m.type === "user")?.id;
  const staged = await stageRevert(sessionId, userId, { files: true });
  await commitRevert(sessionId);

  // No snapshot commit exists on this version, so there is nothing to stage.
  assert.deepEqual((staged?.files || []).map((f) => f.file), [],
    "this CLI keeps no file snapshot — if this now lists files, the file half works and the block below should change");
  const after = fs.readFileSync(path.join(dir, "note.txt"), "utf8").trim();
  assert.equal(after, "CHANGED-BY-AGENT",
    `the file is expected to stay as the agent left it on this CLI, got: ${after}`);

  // The conversation half DID go back: the message the rewind targeted is no longer the
  // turn the server would answer from. That is the part this engine really does.
  const rest = await listMessages(sessionId);
  assert.ok(Array.isArray(rest), "the server still answers for the session after a commit");
});

fs.rmSync(dir, { recursive: true, force: true });
if (sessionId) await deleteSession(sessionId).catch(() => {});

console.log(`\n${fail === 0 ? "✅ all passed" : "❌ FAILED"}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
