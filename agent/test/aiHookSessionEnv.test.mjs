// A chat UI session's CLI must carry the same session env a PTY does: every notify
// hook reads NINE_REMOTE_SESSION_ID and returns early without it, so a chat that
// spawns without it is invisible to status, naming and push.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExtendedEnv, SESSION_ID_ENV } from "../features/ai/adapters/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("\nAI chat sessions run hooks like a terminal");

test("the session id rides along when asked for", () => {
  const env = getExtendedEnv({ hostSessionId: "session-123" });
  assert.equal(env[SESSION_ID_ENV], "session-123");
});

test("a spawn without one does not inherit the agent's own", () => {
  // An agent started from one of our terminals carries that terminal's id; a chat
  // spawning from here must not report its hooks under a session it is not.
  const prev = process.env[SESSION_ID_ENV];
  process.env[SESSION_ID_ENV] = "session-of-the-terminal-that-launched-us";
  try {
    assert.equal(getExtendedEnv({ hostSessionId: "session-123" })[SESSION_ID_ENV], "session-123");
    assert.equal(getExtendedEnv()[SESSION_ID_ENV], "");
    assert.equal(getExtendedEnv({ hostSessionId: null })[SESSION_ID_ENV], "");
  } finally {
    if (prev === undefined) delete process.env[SESSION_ID_ENV];
    else process.env[SESSION_ID_ENV] = prev;
  }
});

test("the PATH repair the callers rely on is untouched", () => {
  const env = getExtendedEnv({ hostSessionId: "session-123" });
  assert.ok(env.PATH && env.PATH.length);
  assert.equal(env.FORCE_COLOR, "1");
});

test("every adapter that spawns a CLI passes the host session id", () => {
  for (const file of ["claudeAdapter.js", "codexAdapter.js", "opencodeAdapter.js", "antigravityAdapter.js"]) {
    const src = read(`features/ai/adapters/${file}`);
    assert.match(src, /hostSessionId/, `${file} must accept a host session id`);
    assert.match(src, /getExtendedEnv\(\{ hostSessionId: this\.hostSessionId \}\)/, `${file} must pass it to the spawn env`);
  }
});

test("the chat session hands its own id to the adapter it builds", () => {
  const src = read("features/ai/aiSession.js");
  const built = src.match(/new \w+Adapter\(\{[\s\S]*?\}\)/g) || [];
  assert.equal(built.length, 4, `expected every adapter construction, saw ${built.length}`);
  for (const block of built) {
    assert.match(block, /hostSessionId: this\.id/, `adapter built without the session id: ${block}`);
  }
});

test("a chat session's name comes from its transcript, not its opening prompt", () => {
  // The AI socket used to name a chat from the first 40 characters of whatever the
  // user typed; the transcript holds the CLI's own title, same as a terminal's.
  const socket = read("features/ai/aiSocket.js");
  assert.doesNotMatch(socket, /renameSessionTitle/, "the prompt-sliced naming must be gone");
  const handler = read("features/terminal/handlers/SessionHandler.js");
  // A chat records "claude-ui", which is no store's id — the title lookup is by engine.
  assert.match(handler, /engineFromAgent\(conv\.agent\)/);
});

if (!process.exitCode) console.log("\nAll tests passed\n");
