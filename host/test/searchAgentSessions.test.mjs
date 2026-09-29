// Smoke test for global agent-history search. Runs against a fake HOME so no
// real transcript store is read. POSIX only — os.homedir() ignores $HOME on win32.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import assert from "node:assert/strict";

if (process.platform === "win32") {
  console.log("skip: $HOME override unsupported on win32");
  process.exit(0);
}

const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-search-"));
process.env.HOME = fakeHome;

const { searchAgentSessions } = await import("../features/terminal/agentHistory.js");

// claude source layout: ~/.claude/projects/<dashEncodedCwd>/<sessionId>.jsonl
const cwd = path.join(fakeHome, "proj");
const dir = path.join(fakeHome, ".claude", "projects", cwd.replace(/[/\\:]/g, "-"));
mkdirSync(dir, { recursive: true });
const sid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
writeFileSync(path.join(dir, `${sid}.jsonl`), [
  JSON.stringify({ type: "user", cwd, message: { content: "fix the login bug" } }),
  JSON.stringify({ type: "assistant", cwd, message: { content: "the login bug was in auth.js line 42" } })
].join("\n"));

// A non-matching sibling proves the scan filters, not just finds.
writeFileSync(path.join(dir, "00000000-0000-0000-0000-000000000000.jsonl"), [
  JSON.stringify({ type: "user", cwd, message: { content: "unrelated topic" } })
].join("\n"));

// Too-short query is rejected at the boundary.
assert.deepEqual((await searchAgentSessions({ query: "x" })).sessions, []);

// Case-insensitive content match across every cwd, with list-shaped rows.
const { sessions, truncated } = await searchAgentSessions({ query: "LOGIN BUG" });
assert.equal(truncated, false);
const row = sessions.find((s) => s.agent === "claude");
assert.ok(row, "claude row found");
assert.equal(row.sessionId, sid);
assert.equal(row.cwd, cwd);
assert.equal(row.title, "fix the login bug");
assert.ok(row.resume?.includes(sid), "resume command carries the session id");
assert.ok(sessions.every((s) => s.agent && s.sessionId), "rows keep the list shape");

// Snippet shows WHERE the query matched, skipping the title's own source line
// (both records match "login bug" — the snippet must come from the second one),
// and reads as prose — clamped to the JSON string, no raw syntax leaking in.
assert.ok(row.snippet?.includes("login bug"), "snippet contains the needle");
assert.ok(row.snippet.includes("auth.js"), "snippet skips the title hit and shows body context");
assert.ok(!row.snippet.includes('"'), "snippet carries no raw JSON syntax");
assert.ok(row.snippet.length <= 202, "snippet stays within one slot (200 max + ellipses)");

rmSync(fakeHome, { recursive: true, force: true });
console.log("✓ searchAgentSessions");
