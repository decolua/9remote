// Which agent conversation a terminal is currently running. Three sources feed
// one answer — the CLI's own hook, the resume line we typed ourselves, and a
// prompt match against the transcript store — because no single one covers every
// CLI: hooks exist for some, resume only for conversations we started, and the
// prompt match is inference that must decline when it cannot be sure.
//
// Run: node --test agent/test/conversationId.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "9r-conv-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".9remote"), { recursive: true });

const { sessionIdFromHookPayload, hookSessionIdKeys, agentIdFromTitle, isShellProcess, agentIdFromProcess } = await import("../features/terminal/agentCatalog.js");
const { setConversationId, getConversation, clearConversation, getStatuses, setSessionAgent, getLiveConversations, clearSessionAgent, getSessionAgent, forgetSession, conversationMetadata, restoreConversation, setConversationPersister, claimResumedConversation } =
  await import("../features/terminal/statusManager.js");
const { matchLiveSessions, resumeCommand } = await import("../features/terminal/agentHistory.js");

// --- reading the id out of a hook payload, per CLI ---

test("each CLI's own session-id field is read from its hook payload", () => {
  assert.equal(sessionIdFromHookPayload("claude", { session_id: "c-1" }), "c-1");
  assert.equal(sessionIdFromHookPayload("codex", { session_id: "x-1" }), "x-1");
  assert.equal(sessionIdFromHookPayload("opencode", { sessionID: "ses_1" }), "ses_1");
  assert.equal(sessionIdFromHookPayload("antigravity", { conversationId: "conv-1" }), "conv-1");
  assert.equal(sessionIdFromHookPayload("grok", { sessionId: "g-1" }), "g-1");
});

test("a CLI accepting more than one spelling takes whichever it was sent", () => {
  assert.equal(sessionIdFromHookPayload("grok", { session_id: "g-2" }), "g-2");
});

test("a payload without the CLI's field, or a CLI with no hook id, yields nothing", () => {
  assert.equal(sessionIdFromHookPayload("claude", { other: "nope" }), null);
  assert.equal(sessionIdFromHookPayload("cursor", { session_id: "c" }), null);
  assert.equal(sessionIdFromHookPayload("unknown-cli", { session_id: "c" }), null);
});

test("an id that is not id-shaped is refused — it would later be typed into a PTY", () => {
  assert.equal(sessionIdFromHookPayload("claude", { session_id: "a; rm -rf /" }), null);
  assert.equal(sessionIdFromHookPayload("claude", { session_id: "" }), null);
  assert.equal(sessionIdFromHookPayload("claude", { session_id: "x".repeat(200) }), null);
});

test("hookSessionIdKeys names only the CLIs whose hooks report an id", () => {
  assert.deepEqual(hookSessionIdKeys("opencode"), ["sessionID"]);
  assert.deepEqual(hookSessionIdKeys("cursor"), []);
});

// --- one conversation per terminal, strongest source wins ---

test("a hook-reported id is recorded against the terminal and its agent", () => {
  clearConversation("s1");
  setConversationId("s1", "codex", "x-1", "hook");
  assert.deepEqual(getConversation("s1"), { agent: "codex", id: "x-1", source: "hook" });
});

test("a weaker source never overwrites a stronger one", () => {
  clearConversation("s2");
  setConversationId("s2", "claude", "hook-id", "hook");
  setConversationId("s2", "claude", "guess-id", "prompt");
  setConversationId("s2", "claude", "resume-id", "resume");
  assert.equal(getConversation("s2").id, "hook-id");
});

test("a stronger source corrects a weaker one", () => {
  clearConversation("s3");
  setConversationId("s3", "claude", "guess-id", "prompt");
  assert.equal(getConversation("s3").id, "guess-id");
  setConversationId("s3", "claude", "real-id", "hook");
  assert.deepEqual(getConversation("s3"), { agent: "claude", id: "real-id", source: "hook" });
});

test("a later conversation in the same terminal replaces the earlier one", () => {
  clearConversation("s4");
  setConversationId("s4", "claude", "first", "hook");
  setConversationId("s4", "claude", "second", "hook");
  assert.equal(getConversation("s4").id, "second");
});

test("switching to a different agent replaces the conversation outright", () => {
  clearConversation("s5");
  setConversationId("s5", "claude", "c-1", "hook");
  setConversationId("s5", "codex", "x-1", "resume");
  assert.deepEqual(getConversation("s5"), { agent: "codex", id: "x-1", source: "resume" });
});

test("an incomplete record is ignored rather than stored half-formed", () => {
  clearConversation("s6");
  setConversationId("s6", "claude", "", "hook");
  setConversationId("s6", "", "id", "hook");
  assert.equal(getConversation("s6"), null);
});

test("a conversation id matching the terminal's own id is rejected", () => {
  clearConversation("session-123");
  setConversationId("session-123", "devin", "session-123", "hook");
  assert.equal(getConversation("session-123"), null);
});

test("statuses carry the conversation so an idle terminal still reports one", () => {
  clearConversation("s7");
  setConversationId("s7", "opencode", "ses_9", "hook");
  const entry = getStatuses().s7;
  assert.equal(entry.conversationId, "ses_9");
  assert.equal(entry.tool, "opencode");
});

// --- matching history rows against live terminals ---

const row = (over = {}) => ({ agent: "claude", sessionId: "conv-1", title: "fix the login bug", ...over });

test("a live terminal reporting the same conversation id claims the row", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-1", agent: "claude", conversationId: "conv-1" }
  ]);
  assert.equal(matched.openSessionId, "term-1");
});

test("a different agent holding the same id is not a match", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-1", agent: "codex", conversationId: "conv-1" }
  ]);
  assert.equal(matched.openSessionId, null);
});

test("with no id reported, an identical prompt identifies the terminal", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-2", agent: "claude", prompt: "fix the login bug" }
  ]);
  assert.equal(matched.openSessionId, "term-2");
});

test("a prompt match ignores case and runs of whitespace", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-3", agent: "claude", prompt: "  Fix   The  Login   Bug " }
  ]);
  assert.equal(matched.openSessionId, "term-3");
});

test("a long prompt still matches when one side was truncated", () => {
  const full = "rewrite the authentication middleware so it stops leaking sessions";
  const [matched] = matchLiveSessions([row({ title: full })], [
    { sessionId: "term-4", agent: "claude", prompt: full.slice(0, 40) }
  ]);
  assert.equal(matched.openSessionId, "term-4");
});

test("a short prompt is never prefix-matched — too little to be sure", () => {
  const [matched] = matchLiveSessions([row({ title: "fix the login bug" })], [
    { sessionId: "term-5", agent: "claude", prompt: "fix" }
  ]);
  assert.equal(matched.openSessionId, null);
});

test("two terminals matching the same prompt leave the row unclaimed", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-6", agent: "claude", prompt: "fix the login bug" },
    { sessionId: "term-7", agent: "claude", prompt: "fix the login bug" }
  ]);
  assert.equal(matched.openSessionId, null);
});

test("a reported id outranks a prompt that points elsewhere", () => {
  const [matched] = matchLiveSessions([row()], [
    { sessionId: "term-8", agent: "claude", prompt: "fix the login bug" },
    { sessionId: "term-9", agent: "claude", conversationId: "conv-1" }
  ]);
  assert.equal(matched.openSessionId, "term-9");
});

test("a terminal already claimed by id cannot also be claimed by prompt", () => {
  const rows = [row({ sessionId: "conv-1" }), row({ sessionId: "conv-2" })];
  const [byId, byPrompt] = matchLiveSessions(rows, [
    { sessionId: "term-10", agent: "claude", conversationId: "conv-1", prompt: "fix the login bug" }
  ]);
  assert.equal(byId.openSessionId, "term-10");
  assert.equal(byPrompt.openSessionId, null);
});

test("an untitled row is never prompt-matched", () => {
  const [matched] = matchLiveSessions([row({ title: "" })], [
    { sessionId: "term-11", agent: "claude", prompt: "" }
  ]);
  assert.equal(matched.openSessionId, null);
});

test("no live terminals leaves every row unclaimed", () => {
  const [matched] = matchLiveSessions([row()], []);
  assert.equal(matched.openSessionId, null);
});

// --- fallback 1: the resume line the user typed is the id, verbatim ---

const { parseResumeLine } = await import("../features/terminal/agentCatalog.js");

test("a typed resume line names its agent and conversation id", () => {
  assert.deepEqual(parseResumeLine("claude --resume abc"), { agent: "claude", id: "abc" });
  assert.deepEqual(parseResumeLine("codex resume abc"), { agent: "codex", id: "abc" });
  assert.deepEqual(parseResumeLine("opencode --session ses_1"), { agent: "opencode", id: "ses_1" });
  assert.deepEqual(parseResumeLine("agy --conversation conv-1"), { agent: "antigravity", id: "conv-1" });
  assert.deepEqual(parseResumeLine("kimi --session abc"), { agent: "kimi", id: "abc" });
  assert.deepEqual(parseResumeLine("copilot --resume=abc"), { agent: "copilot", id: "abc" });
});

test("a resume line typed with env prefixes, sudo, a full path, or a bypass flag still parses", () => {
  assert.deepEqual(parseResumeLine("claude --resume abc --dangerously-skip-permissions"), { agent: "claude", id: "abc" });
  assert.deepEqual(parseResumeLine("FOO=1 /usr/local/bin/claude --resume abc"), { agent: "claude", id: "abc" });
  assert.deepEqual(parseResumeLine("sudo codex resume abc"), { agent: "codex", id: "abc" });
});

test("a plain launch, an unknown command, or garbage is not a resume", () => {
  assert.equal(parseResumeLine("claude"), null);
  assert.equal(parseResumeLine("vim --resume abc"), null);
  assert.equal(parseResumeLine("claude --resume a; rm -rf /"), null);
  assert.equal(parseResumeLine(""), null);
});

// --- fallback 3 feed: the prompt the user typed into the running TUI ---

const { setLastPrompt, getLastPrompt } = await import("../features/terminal/statusManager.js");

test("the last clean typed line is offered as the terminal's prompt", () => {
  setSessionAgent("s8", "claude");
  setLastPrompt("s8", "rewrite the auth middleware");
  const live = getLiveConversations();
  const entry = live.find((l) => l.sessionId === "s8");
  assert.equal(entry.prompt, "rewrite the auth middleware");
});

test("control sequences, slash commands and shell lines are not prompts", () => {
  setSessionAgent("s9", "claude");
  setLastPrompt("s9", "\u001b[A");
  setLastPrompt("s9", "/model");
  setLastPrompt("s9", "ls -la && rm -rf /");
  assert.equal(getLiveConversations().find((l) => l.sessionId === "s9").prompt, "");
});

// --- fallback 2: the transcript that started with the terminal ---

const started = (n) => ({ sessionId: `t-${n}`, agent: "claude", startedAt: 1000, cwd: "/w" });

test("the only transcript of that agent and cwd newer than the terminal is its conversation", () => {
  const rows = [{ agent: "claude", sessionId: "new-1", title: "", cwd: "/w", updatedAt: 2000 }];
  const [matched] = matchLiveSessions(rows, [started(1)]);
  assert.equal(matched.openSessionId, "t-1");
});

test("a transcript last written before the terminal started is not its conversation", () => {
  const rows = [{ agent: "claude", sessionId: "old-1", title: "", cwd: "/w", updatedAt: 500 }];
  const [matched] = matchLiveSessions(rows, [started(1)]);
  assert.equal(matched.openSessionId, null);
});

test("two terminals of the same agent and cwd leave the row unclaimed", () => {
  const rows = [{ agent: "claude", sessionId: "new-2", title: "", cwd: "/w", updatedAt: 2000 }];
  const [matched] = matchLiveSessions(rows, [started(1), started(2)]);
  assert.equal(matched.openSessionId, null);
});

test("a transcript in another cwd or of another agent is not a candidate", () => {
  const rows = [
    { agent: "codex", sessionId: "x", title: "", cwd: "/w", updatedAt: 2000 },
    { agent: "claude", sessionId: "y", title: "", cwd: "/elsewhere", updatedAt: 2000 }
  ];
  const matched = matchLiveSessions(rows, [started(1)]);
  assert.equal(matched[0].openSessionId, null);
  assert.equal(matched[1].openSessionId, null);
});

// --- regressions found on review ---

test("a closed terminal stops claiming its conversation", () => {
  setConversationId("gone", "claude", "c-gone", "hook");
  setSessionAgent("gone", "claude");
  clearSessionAgent("gone");
  clearConversation("gone");
  assert.equal(getLiveConversations().some((l) => l.sessionId === "gone"), false);
});

test("a session id that would inject shell metacharacters cannot reach a resume line", () => {
  assert.equal(resumeCommand("claude", "a`whoami`"), "claude --resume \'a`whoami`\'");
});

test("a plain shell's command line is not stored as a prompt", () => {
  clearSessionAgent("s10");
  setLastPrompt("s10", "npm run build");
  assert.equal(getLastPrompt("s10"), "");
  setSessionAgent("s10", "claude");
  setLastPrompt("s10", "now this one is a prompt");
  assert.equal(getLastPrompt("s10"), "now this one is a prompt");
});

test("every teardown path forgets the terminal's conversation, not just the daemon one", () => {
  // The four sessions.delete sites in SessionHandler and the daemon close in
  // terminalSocket must all converge on one teardown, or a dead terminal keeps
  // claiming history rows and a reused session id inherits a stranger's chat.
  setSessionAgent("torn", "claude");
  setConversationId("torn", "claude", "c-torn", "hook");
  setLastPrompt("torn", "a prompt that must not outlive its terminal");

  forgetSession("torn");

  assert.equal(getConversation("torn"), null);
  assert.equal(getLastPrompt("torn"), "");
  assert.equal(getSessionAgent("torn"), null);
  assert.equal(getLiveConversations().some((l) => l.sessionId === "torn"), false);
});

test("a TUI exiting leaves the terminal alive but ends its conversation", () => {
  setSessionAgent("shell", "claude");
  setConversationId("shell", "claude", "c-shell", "hook");
  // The agent is gone; the terminal is back to a bare shell and holds no chat.
  clearSessionAgent("shell");
  assert.equal(getConversation("shell"), null);
});

// --- surviving an agent restart ---

test("a terminal's conversation is written into its metadata and read back", () => {
  setSessionAgent("kept", "codex");
  setConversationId("kept", "codex", "x-kept", "hook");
  setLastPrompt("kept", "the prompt that opened this conversation");

  // What the agent persists on shutdown, and reads on the next boot.
  const saved = conversationMetadata("kept");
  assert.deepEqual(saved, { agent: "codex", conversationId: "x-kept", conversationSource: "hook" });

  // A fresh process: nothing in memory until the metadata is replayed.
  forgetSession("kept");
  assert.equal(getConversation("kept"), null);

  restoreConversation("kept", saved);
  assert.deepEqual(getConversation("kept"), { agent: "codex", id: "x-kept", source: "hook" });
  assert.equal(getSessionAgent("kept"), "codex");
});

test("a restored conversation is still correctable by a live hook", () => {
  forgetSession("rst");
  restoreConversation("rst", { agent: "claude", conversationId: "old", conversationSource: "hook" });
  setConversationId("rst", "claude", "fresh", "hook");
  assert.equal(getConversation("rst").id, "fresh");
});

test("metadata with no conversation restores nothing and throws nothing", () => {
  forgetSession("bare");
  restoreConversation("bare", { name: "just a shell" });
  restoreConversation("bare", null);
  assert.equal(getConversation("bare"), null);
});

test("a conversation id from disk is validated like one off the wire", () => {
  forgetSession("evil");
  restoreConversation("evil", { agent: "claude", conversationId: "a; rm -rf /", conversationSource: "hook" });
  assert.equal(getConversation("evil"), null);
});

test("a terminal with no conversation still records which agent it ran", () => {
  forgetSession("agentonly");
  setSessionAgent("agentonly", "opencode");
  assert.deepEqual(conversationMetadata("agentonly"), { agent: "opencode" });
});

test("learning a conversation writes it out, and re-learning the same one does not", () => {
  const writes = [];
  setConversationPersister((id) => writes.push(id));
  forgetSession("persisted");

  setConversationId("persisted", "claude", "c-1", "hook");
  assert.deepEqual(writes, ["persisted"]);

  // The same hook fires on every turn; only a real change is worth a disk write.
  setConversationId("persisted", "claude", "c-1", "hook");
  assert.deepEqual(writes, ["persisted"]);

  setConversationId("persisted", "claude", "c-2", "hook");
  assert.deepEqual(writes, ["persisted", "persisted"]);
  setConversationPersister(null);
});

test("a corrected source is persisted even when the id is unchanged", () => {
  // A guessed id later confirmed by a hook is the same string but no longer a
  // guess: a restart must bring back the confirmation, not the guess.
  const writes = [];
  forgetSession("upgraded");
  setConversationId("upgraded", "claude", "c-same", "prompt");
  setConversationPersister((id) => writes.push(id));
  setConversationId("upgraded", "claude", "c-same", "hook");
  assert.equal(getConversation("upgraded").source, "hook");
  assert.deepEqual(writes, ["upgraded"], "the upgraded source reached disk");
  setConversationPersister(null);
});

test("the agent a terminal runs is persisted the moment it is known", () => {
  // Without this, a terminal running a CLI that reports no conversation id
  // forgets which CLI it was running across a restart, and the fallbacks that
  // depend on knowing the agent go blind.
  const writes = [];
  forgetSession("agentlearned");
  setConversationPersister((id) => writes.push(id));
  setSessionAgent("agentlearned", "cursor");
  assert.deepEqual(writes, ["agentlearned"]);
  setConversationPersister(null);
});

test("metadata missing its source is restored as a guess, not as proof", () => {
  // Written by an older agent that persisted no source. Defaulting to "hook"
  // would launder it into proof, and then lock out the live hook that could
  // have corrected it — the one case where a wrong id cannot be fixed.
  forgetSession("legacy");
  restoreConversation("legacy", { agent: "claude", conversationId: "c-old" });
  assert.equal(getConversation("legacy").source, "prompt");
  setConversationId("legacy", "claude", "c-real", "hook");
  assert.equal(getConversation("legacy").id, "c-real");
});

test("a restored hook id is not displaced by a later guess", () => {
  forgetSession("proven");
  restoreConversation("proven", { agent: "claude", conversationId: "c-proven", conversationSource: "hook" });
  setConversationId("proven", "claude", "c-guess", "prompt");
  assert.equal(getConversation("proven").id, "c-proven");
});

test("replaying from disk does not write back to disk", () => {
  // Boot rebuilds the session map one entry at a time. A write triggered mid-loop
  // persists a half-built map, and the loop has N entries to go — so a restart is
  // the one moment a stray write can drop every session after the current one.
  const writes = [];
  forgetSession("replayed");
  setConversationPersister((id) => writes.push(id));
  restoreConversation("replayed", { agent: "claude", conversationId: "c-1", conversationSource: "hook" });
  assert.deepEqual(writes, [], "reading the disk is not news to write back");
  assert.deepEqual(getConversation("replayed"), { agent: "claude", id: "c-1", source: "hook" });
  setConversationPersister(null);
});

test("a terminal that switches CLI no longer reports the old conversation", () => {
  forgetSession("switched");
  setSessionAgent("switched", "claude");
  setConversationId("switched", "claude", "c-old", "hook");
  // The user quit claude and started codex; that claude chat is not running here.
  setSessionAgent("switched", "codex");
  assert.equal(getConversation("switched"), null);
  assert.deepEqual(conversationMetadata("switched"), { agent: "codex" });
});

// --- a resume names its conversation up front ---

test("a resume claims its conversation for the new terminal immediately", () => {
  // We typed the resume line ourselves, so the id is known before the CLI has
  // said anything. Waiting for a hook means the terminal is unlinked from the
  // chat it is literally resuming until the user sends a message.
  forgetSession("fresh");
  claimResumedConversation("fresh", { agent: "codex", sessionId: "x-1" });
  assert.deepEqual(getConversation("fresh"), { agent: "codex", id: "x-1", source: "resume" });
  assert.equal(getSessionAgent("fresh"), "codex");
});

test("a live hook still corrects a claimed conversation", () => {
  forgetSession("corrected");
  claimResumedConversation("corrected", { agent: "claude", sessionId: "guessed" });
  setConversationId("corrected", "claude", "actual", "hook");
  assert.equal(getConversation("corrected").id, "actual");
});

test("a claim with nothing to claim is ignored", () => {
  forgetSession("empty");
  claimResumedConversation("empty", { agent: "claude" });
  claimResumedConversation("empty", { sessionId: "x" });
  claimResumedConversation("empty", null);
  assert.equal(getConversation("empty"), null);
});

test("a claimed id is validated like any other", () => {
  forgetSession("hostile");
  claimResumedConversation("hostile", { agent: "claude", sessionId: "a; rm -rf /" });
  assert.equal(getConversation("hostile"), null);
});

test("claude title prefixes take precedence and ignore agent mentions in task text", () => {
  assert.equal(agentIdFromTitle("✳ Fix antigravity issue"), "claude");
  assert.equal(agentIdFromTitle("⠋ Claude Code researching antigravity"), "claude");
  assert.equal(agentIdFromTitle("⠋ Codex - writing tests"), "codex");
  assert.equal(agentIdFromTitle("Codex - CLAUDE.md"), "codex");
  assert.equal(agentIdFromTitle("CLAUDE.md"), null);
  assert.equal(agentIdFromTitle("⠋ CLAUDE.md"), null);
  assert.equal(agentIdFromTitle("⠋ Checking for updates..."), null);
  assert.equal(agentIdFromTitle("* Skip update"), null);
  assert.equal(agentIdFromTitle("Claude Code - building app"), "claude");
  assert.equal(agentIdFromTitle("Antigravity - test"), "antigravity");
  assert.equal(agentIdFromTitle("agy: working"), "antigravity");
  assert.equal(agentIdFromTitle("Grok - building feature"), "grok");
  assert.equal(agentIdFromTitle("Hermes - agent"), "hermes");
  assert.equal(agentIdFromTitle("Random text mentioning antigravity"), null);
});

test("isShellProcess identifies shells vs agent binaries", () => {
  assert.equal(isShellProcess("zsh"), true);
  assert.equal(isShellProcess("bash"), true);
  assert.equal(isShellProcess("pwsh.exe"), true);
  assert.equal(isShellProcess("cmd.exe"), true);
  assert.equal(isShellProcess("claude"), false);
  assert.equal(isShellProcess("node"), false);
});

test("agentIdFromProcess maps known agent binaries", () => {
  assert.equal(agentIdFromProcess("claude"), "claude");
  assert.equal(agentIdFromProcess("codex"), "codex");
  assert.equal(agentIdFromProcess("agy"), "antigravity");
  assert.equal(agentIdFromProcess("zsh"), null);
});

