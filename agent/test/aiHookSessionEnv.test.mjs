// A chat UI session's CLI must carry the same session env a PTY does: every notify
// hook reads NINE_REMOTE_SESSION_ID and returns early without it, so a chat that
// spawns without it is invisible to status, naming and push.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExtendedEnv, SESSION_ID_ENV, CLAUDE_ENTRYPOINT_ENV, PROGRAMMATIC_ENTRYPOINTS } from "../features/ai/adapters/env.js";
import { EVENT_TO_STATE, restatesOverGate } from "../features/ai/aiStatus.js";

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

test("every event the adapters emit is either mapped or deliberately silent", () => {
  // A chat's status comes from this table alone. An event the adapters emit but the
  // table does not name says nothing — which is fine for `delta`, and was NOT fine for
  // `blocked`, which codex and opencode emit and nothing mapped.
  const emitted = new Set();
  for (const file of ["claudeAdapter.js", "codexAdapter.js", "opencodeAdapter.js", "antigravityAdapter.js"]) {
    for (const m of read(`features/ai/adapters/${file}`).matchAll(/onEvent\?\.\("(\w+)"/g)) emitted.add(m[1]);
  }
  for (const m of read("features/ai/aiSession.js").matchAll(/emitNormalized\("(\w+)"/g)) emitted.add(m[1]);

  // Only the ones with nothing to say about status. Mapped events are not repeated here:
  // a name in both lists would prove nothing, since the filter below passes either way.
  //
  // `cli_event` is the door every harness record travels through — including the task
  // ones (`task_started`, `task_notification`, `background_tasks_changed`), which are the
  // CLI's own subtypes inside it, not top-level event names. A task is a work ITEM, not
  // the turn: a background shell routinely outlives the turn that launched it, so mapping
  // one to "working" would drag the dot back off `done` and tell the user it is their turn
  // while the agent is finished. What surfaces them is the strip, which reads the task set.
  const noStatus = new Set([
    "delta", "thinking", "tool_result", "diff", "stats", "init", "ansi", "goal",
    "cli_event"
  ]);
  const unmapped = [...emitted].filter((e) => !Object.hasOwn(EVENT_TO_STATE, e) && !noStatus.has(e));
  assert.deepEqual(unmapped, [], `events no one decided about: ${unmapped.join(", ")}`);

  // The events that end a turn must carry a state, not merely pass as decided.
  for (const e of ["turn_complete", "stopped", "stall", "error", "exit"]) {
    assert.ok(EVENT_TO_STATE[e], `${e} must carry a state`);
  }
  // And the gate, which is the one that was silently missing.
  assert.equal(EVENT_TO_STATE.blocked, "blocked");
});

test("a restatement clears a gate only when a card is still open", () => {
  // Two `blocked`s look identical in the status map and come from opposite places. A card
  // open means the CLI is waiting on US, and a typed message does not answer it — the
  // client denies the card as it sends, so permission_resolved moves the dot itself.
  // No card means the CLI reported a fact about itself (codex's sandbox refusal): the
  // next turn really is running, and nothing should be filtered.
  assert.equal(restatesOverGate("user_message", "blocked", true), true, "card open: do not clear it");
  assert.equal(restatesOverGate("tool_start", "blocked", true), true);
  assert.equal(restatesOverGate("user_message", "blocked", false), false, "no card: the turn is running");
  assert.equal(restatesOverGate("tool_start", "blocked", false), false);

  // Events that ARE about the gate always reach the map, card or not.
  for (const e of ["permission_resolved", "permission_request", "turn_complete", "blocked"]) {
    assert.equal(restatesOverGate(e, "blocked", true), false, `${e} must reach the map`);
  }
  // And nothing is filtered outside blocked — a gate can only be held while blocked.
  for (const s of ["idle", "working", "done", undefined]) {
    assert.equal(restatesOverGate("user_message", s, true), false, `filtered outside blocked: ${s}`);
  }
});

if (!process.exitCode) console.log("\nAll tests passed\n");

// ── the chat's transcript must be visible to the TUI's /resume ──
//
// `claude -p` stamps each transcript with the entrypoint it ran under, and `/resume`
// hides any transcript whose entrypoint is one of PROGRAMMATIC_ENTRYPOINTS
// (["sdk-cli","sdk-ts","sdk-py"]) unless the CURRENT process is also programmatic.
// The CLI decides that from its own argv, not from the env var, so a chat that lets it
// default is stamped `sdk-cli` and disappears from the TUI's /resume — one conversation,
// two histories, which is what the user sees as "UI and TUI do not share conversation id".
//
// Verified against 2.1.270: the env var is honoured VERBATIM for a value the CLI does not
// recognise, while `cli` is rewritten to `sdk-cli` because the process is non-interactive.
test("a chat stamps a transcript entrypoint the TUI's /resume does not hide", () => {
  const env = getExtendedEnv({ hostSessionId: "session-123" });
  const stamp = env[CLAUDE_ENTRYPOINT_ENV];
  assert.ok(stamp, "the chat must stamp its own entrypoint, or it defaults to sdk-cli");
  assert.ok(!PROGRAMMATIC_ENTRYPOINTS.includes(stamp),
    `"${stamp}" is on the CLI's programmatic list, which /resume filters out`);
  assert.notEqual(stamp, "cli", "the CLI rewrites `cli` to `sdk-cli` on a non-interactive stdin");
});

test("the stamp survives an inherited value from the machine's own shell", () => {
  const prev = process.env[CLAUDE_ENTRYPOINT_ENV];
  process.env[CLAUDE_ENTRYPOINT_ENV] = "sdk-cli";
  try {
    const env = getExtendedEnv({ hostSessionId: "s" });
    assert.notEqual(env[CLAUDE_ENTRYPOINT_ENV], "sdk-cli", "never inherit a value /resume filters");
  } finally {
    if (prev === undefined) delete process.env[CLAUDE_ENTRYPOINT_ENV];
    else process.env[CLAUDE_ENTRYPOINT_ENV] = prev;
  }
});
