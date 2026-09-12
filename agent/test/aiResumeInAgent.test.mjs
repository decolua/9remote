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
const { AiManager } = await import("../features/ai/aiManager.js");

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

// Opening a chat from the history list hands the conversation id to `ai:create` as
// `options.cliSessionId`. The constructor used to ignore that name entirely, so codex
// and opencode panes came up empty — bound to nothing and replaying nothing.
const { AiSession } = await import("../features/ai/aiSession.js");

test("codex binds the conversation id and replays it on construction", () => {
  const codexId = "01a09616-67a3-7470-9745-70ceaa6d5231";
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-codex-"));
  const fixture = path.join(process.env.CODEX_HOME, "sessions", "2099", "01", "02");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, `rollout-2099-01-02T00-00-00-${codexId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "hello codex" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "hi" }] } }),
  ].join("\n"));

  const s = new AiSession({ id: "resume-codex", engine: "codex", cwd, options: { cliSessionId: codexId } });
  try {
    assert.equal(s.threadId, codexId, "threadId must be bound, or the turn starts a new thread");
    assert.equal(s.adapter.activeThreadId, codexId);
    assert.equal(s.history.filter((e) => e.event === "user_message")[0]?.data.text, "hello codex");
  } finally {
    s.destroy();
    fs.rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
    delete process.env.CODEX_HOME;
  }
});

test("an engine without a transcript store still binds the id it was given", () => {
  const s = new AiSession({ id: "resume-opencode", engine: "opencode", cwd, options: { cliSessionId: "ses_notarealsession" } });
  try {
    assert.equal(s.cliSessionId, "ses_notarealsession");
    assert.equal(s.adapter.activeSessionId, "ses_notarealsession");
    assert.deepEqual(s.history, []);
  } finally {
    s.destroy();
  }
});

// The transcript reader has to survive a client-supplied id, exactly like the claude one.
test("an antigravity id is validated before it becomes a path segment", () => {
  assert.equal(recoverFromTranscript("antigravity", cwd, "../../etc/passwd"), null);
});

// `cliSessionId` arrives from a client and ends up in the CLI's argv, so the session
// must reject anything that would be read as a flag.
test("a resume id beginning with a dash never reaches the adapter", () => {
  const s = new AiSession({ id: "resume-dash", engine: "codex", cwd, options: { mock: true, cliSessionId: "--dangerously-bypass-approvals-and-sandbox" } });
  try {
    assert.equal(s.threadId, null);
  } finally {
    s.destroy();
  }
});

fs.rmSync(transcriptPath, { force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
