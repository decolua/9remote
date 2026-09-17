// Codex's rewind, against a stand-in app-server.
//
// The door it uses was measured on the real server before this file existed: `thread/fork`
// mints a SECOND conversation (not a rewind), `thread/revert` replaces the thread's own
// history with the prefix before a turn, keeping the same id. These tests hold the shape
// of the calls and the answers; codexAppServerE2E.e2e.test.mjs runs the same door against
// the real binary.
//
// Run: node agent/test/codexRewind.test.mjs
import assert from "node:assert/strict";
import { listRewindPoints, previewRewind, applyRewind } from "../features/ai/codexRewind.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// A session shaped like the real one, over a fake rpc that records what was asked.
function fakeSession({ turns = [], fail = null } = {}) {
  const asked = [];
  const rpc = {
    request(method, params) {
      asked.push({ method, params });
      if (fail) return Promise.reject(new Error(fail));
      if (method === "thread/turns/list") return Promise.resolve({ data: turns });
      return Promise.resolve({ thread: { id: "t-1" }, turnsBackwardsCursor: null });
    }
  };
  return {
    asked,
    session: { adapter: { appServer: { rpc }, activeThreadId: "t-1" } }
  };
}

const turn = (id, text) => ({
  id, startedAt: 1789572919,
  items: [{ type: "userMessage", id: `${id}-u`, content: [{ type: "text", text }] }]
});

await test("a thread's turns read back as rewind points, oldest first", async () => {
  const { session, asked } = fakeSession({
    turns: [turn("turn-1", "first"), turn("turn-2", "second")]
  });
  const points = await listRewindPoints(session);
  assert.deepEqual(points.map((p) => p.messageId), ["turn-1", "turn-2"]);
  assert.equal(points[0].text, "first", "the prompt names the turn in the dialog");
  assert.equal(asked[0].params.sortDirection, "asc");
  // `summary` is what keeps this from walking every item of every turn.
  assert.equal(asked[0].params.itemsView, "summary");
});

await test("reverting keeps the thread — no fork, no second conversation", async () => {
  const { session, asked } = fakeSession();
  const res = await applyRewind(session, "turn-2");
  assert.equal(res.ok, true);
  const call = asked.find((a) => a.method === "thread/revert");
  assert.ok(call, "the cut goes through thread/revert");
  assert.equal(call.params.beforeTurnId, "turn-2");
  assert.equal(call.params.threadId, "t-1");
  assert.ok(!asked.some((a) => a.method === "thread/fork"), "a fork is not a rewind");
});

await test("the file half is stated, not implied", async () => {
  // The dialog reads `note` and `files`; a rewind that silently restored nothing would
  // read as "nothing changes", which is a different claim from "this engine cannot".
  const { session } = fakeSession();
  const res = await applyRewind(session, "turn-2");
  assert.deepEqual(res.files, []);
  assert.equal(res.filesUnknown, false);
  assert.match(res.note, /conversation only/i);
});

await test("a preview refuses a turn the server no longer knows", async () => {
  // The cut would be ACCEPTED and land somewhere else, which is worse than refusing.
  const { session } = fakeSession({ turns: [turn("turn-1", "only")] });
  const res = await previewRewind(session, "turn-gone");
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer in this conversation/);
});

await test("a preview of a turn that IS there says so without touching the thread", async () => {
  const { session, asked } = fakeSession({ turns: [turn("turn-1", "a"), turn("turn-2", "b")] });
  const res = await previewRewind(session, "turn-2");
  assert.equal(res.ok, true);
  assert.ok(!asked.some((a) => a.method === "thread/revert"), "a preview does not cut");
});

await test("a server that refuses is reported, not swallowed", async () => {
  const { session } = fakeSession({ fail: "no such turn" });
  const res = await applyRewind(session, "turn-2");
  assert.equal(res.ok, false);
  assert.match(res.error, /no such turn/);
});

await test("a chat with no thread at all is refused rather than crashing", async () => {
  const bare = { adapter: {} };
  assert.deepEqual(await listRewindPoints(bare), []);
  assert.equal((await applyRewind(bare, "t")).ok, false);
  assert.equal((await previewRewind(bare, "t")).ok, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
