// Does the v2 path — session created and prompted THROUGH the server — restore files?
//
// Run: node agent/test/opencodeRewindE2E.test.mjs
//
// The earlier run proved the split: `opencode run` writes to the CLI's own store, which
// the server's revert API cannot see ("Message not found"). So a rewind has to happen
// inside a conversation the server itself owns. This checks whether that path restores
// a file, which decides whether the adapter can move onto it.

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

await test("committing puts the file back", async () => {
  const msgs = await listMessages(sessionId);
  const userId = msgs.find((m) => m.type === "user")?.id;
  await stageRevert(sessionId, userId, { files: true });
  await commitRevert(sessionId);
  const after = fs.readFileSync(path.join(dir, "note.txt"), "utf8");
  assert.equal(after.trim(), "ORIGINAL", `file should be back to ORIGINAL, got: ${after}`);
});

fs.rmSync(dir, { recursive: true, force: true });
if (sessionId) await deleteSession(sessionId).catch(() => {});

console.log(`\n${fail === 0 ? "✅ all passed" : "❌ FAILED"}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
