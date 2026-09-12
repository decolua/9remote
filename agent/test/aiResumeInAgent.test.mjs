// The in-agent AI path (used whenever the PTY daemon is not connected at the moment
// a chat session is created) must honour /resume the same way the daemon does.
// Run: node agent/test/aiResumeInAgent.test.mjs
//
// Regression: setOptions handled codex/opencode/antigravity but not claude, so a
// claude chat silently kept its old conversation and the pane never changed — and
// recoverFromTranscript returned null for claude, blanking the replayed log.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

const { recoverFromTranscript } = await import("../features/ai/transcript.js");

console.log("Running in-agent AI resume tests...");

// A real Claude transcript fixture written into the layout recoverFromClaudeTranscript
// searches (~/.claude/projects/<dashed-cwd>/<id>.jsonl).
const cwd = path.join(os.tmpdir(), "9remote-resume-test");
const projectsDir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[/\\:]/g, "-"));
const sessionId = "11111111-2222-3333-4444-555555555555";
const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`);

fs.mkdirSync(projectsDir, { recursive: true });
fs.writeFileSync(transcriptPath, [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello there" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
].join("\n"));

test("claude resuming from the in-agent path rebuilds the transcript", () => {
  const events = recoverFromTranscript("claude", cwd, sessionId);
  assert.ok(Array.isArray(events), "expected a replayed log, got null — pane would stay empty");
  assert.equal(events.filter((e) => e.event === "user_message").length, 1);
  assert.equal(events[0].data.text, "hello there");
});

test("an unknown id yields null rather than throwing", () => {
  assert.equal(recoverFromTranscript("claude", cwd, "no-such-session"), null);
});

test("a path-traversal id is rejected before it reaches the filesystem", () => {
  assert.equal(recoverFromTranscript("claude", cwd, "../../etc/passwd"), null);
});

test("a claude resume rebinds cliSessionId on the session", () => {
  const SESSION = fs.readFileSync(path.join(import.meta.dirname, "../features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /if \(this\.engine === AI_ENGINES\.CLAUDE\) this\.cliSessionId = resume;/);
});

fs.rmSync(transcriptPath, { force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
