// The remembered surface of each past conversation: which one the history list
// reopens as a chat, and the fact that both surfaces of one conversation collide
// on a single key.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "convModes-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { getConversationMode, setConversationMode, modeFromAgent, engineFromAgent, MODE } =
  await import("../features/terminal/conversationModes.js");

assert.equal(modeFromAgent("claude-ui"), MODE.UI);
assert.equal(modeFromAgent("claude"), MODE.TERMINAL);
assert.equal(engineFromAgent("claude-ui"), "claude");
assert.equal(engineFromAgent("opencode-ui"), "opencode");

// Unrecorded conversations have no surface to restore.
assert.equal(getConversationMode("claude", "conv-1"), null);

setConversationMode("claude", "conv-1", MODE.TERMINAL);
assert.equal(getConversationMode("claude", "conv-1"), MODE.TERMINAL);

// The UI's CLI is the same conversation: switching surfaces overwrites, never forks.
setConversationMode("claude-ui", "conv-1", MODE.UI);
assert.equal(getConversationMode("claude", "conv-1"), MODE.UI);
assert.equal(getConversationMode("claude-ui", "conv-1"), MODE.UI);

// Another engine's identical id is its own conversation.
assert.equal(getConversationMode("opencode", "conv-1"), null);

const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, ".9remote", "state", "conversationModes.json"), "utf8"));
assert.deepEqual(onDisk, { "claude:conv-1": "ui" });

// A session running the chat UI carries the "-ui" marker, but holds the same
// conversation as the CLI row — the history list must still recognise it as open,
// or the row would offer to resume a conversation that is already on screen.
const { matchLiveSessions } = await import("../features/terminal/agentHistory.js");
const rows = [{ agent: "claude", sessionId: "conv-1", title: "t", cwd: "/p", updatedAt: Date.now() }];
const live = [{ sessionId: "sess-a", agent: "claude-ui", conversationId: "conv-1" }];
const [matched] = matchLiveSessions(rows, live);
assert.equal(matched.openSessionId, "sess-a");
assert.equal(matched.mode, "ui");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("conversationModes: ok");
