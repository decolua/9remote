// Tests for the shared agent-chat store: one subscription per session no matter how many
// components watch it, and a burst of activity coalesced into one refetch.
// Run: node web/test/agentChatStore.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { acquire, release, REFETCH_DEBOUNCE_MS, _entryCountForTest } from "../features/agentChat/lib/agentChatStore.js";
import { EVENTS } from "../features/agentChat/constants/agentChatConfig.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(REFETCH_DEBOUNCE_MS + 40);

// Socket double: counts subscribes, lets the test push server events.
function fakeSocket(state = {}) {
  const s = new EventEmitter();
  s.subscribeCount = 0;
  s.emit = (event, payload, ack) => {
    if (event === EVENTS.SUBSCRIBE) {
      s.subscribeCount++;
      ack?.({ success: true, hasAgent: true, tool: "claude", prompt: null, activity: [], optionCount: 0, ...state });
      return true;
    }
    return EventEmitter.prototype.emit.call(s, event, payload, ack);
  };
  s.push = (event, payload) => EventEmitter.prototype.emit.call(s, event, payload);
  return s;
}

const SID = "session-1";

await test("two watchers on one session share a single subscription", async () => {
  const socket = fakeSocket();
  const a = acquire(socket, SID, () => {});
  const b = acquire(socket, SID, () => {});
  await settle();
  assert.equal(socket.subscribeCount, 1, "each component subscribing separately doubles the traffic");
  release(socket, SID, a);
  release(socket, SID, b);
});

await test("both watchers receive the same state", async () => {
  const socket = fakeSocket({ tool: "claude" });
  let seenA = null;
  let seenB = null;
  const a = acquire(socket, SID, (s) => { seenA = s; });
  const b = acquire(socket, SID, (s) => { seenB = s; });
  await settle();
  assert.equal(seenA?.tool, "claude");
  assert.equal(seenB?.tool, "claude");
  release(socket, SID, a);
  release(socket, SID, b);
});

await test("a burst of activity events collapses into one refetch", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  const base = socket.subscribeCount;

  // Claude runs dozens of tools per turn; one round-trip each would be a request storm.
  for (let i = 0; i < 25; i++) socket.push(EVENTS.ACTIVITY, { sessionId: SID });
  await settle();

  assert.equal(socket.subscribeCount - base, 1, `25 events caused ${socket.subscribeCount - base} refetches`);
  release(socket, SID, h);
});

await test("separated activity events each cause a refetch", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  const base = socket.subscribeCount;

  socket.push(EVENTS.ACTIVITY, { sessionId: SID });
  await settle();
  socket.push(EVENTS.ACTIVITY, { sessionId: SID });
  await settle();

  assert.equal(socket.subscribeCount - base, 2);
  release(socket, SID, h);
});

await test("events for another session are ignored", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  const base = socket.subscribeCount;

  socket.push(EVENTS.ACTIVITY, { sessionId: "someone-else" });
  await settle();

  assert.equal(socket.subscribeCount, base);
  release(socket, SID, h);
});

await test("a prompt event reaches watchers without waiting for the debounce", async () => {
  const socket = fakeSocket();
  let seen = null;
  const h = acquire(socket, SID, (s) => { seen = s; });
  await settle();

  const prompt = { promptId: "p1", kind: "permission", toolName: "Bash" };
  socket.push(EVENTS.PROMPT, { sessionId: SID, prompt });

  // A blocked CLI must surface immediately — the user is waiting on this card.
  assert.equal(seen?.prompt?.promptId, "p1");
  release(socket, SID, h);
});

await test("a cleared prompt is applied immediately too", async () => {
  const socket = fakeSocket();
  let seen = null;
  const h = acquire(socket, SID, (s) => { seen = s; });
  await settle();

  socket.push(EVENTS.PROMPT, { sessionId: SID, prompt: { promptId: "p1", kind: "permission" } });
  socket.push(EVENTS.PROMPT_CLEARED, { sessionId: SID });

  assert.equal(seen?.prompt, null);
  release(socket, SID, h);
});

await test("a stale prompt keeps the card and flags it", async () => {
  const socket = fakeSocket();
  let seen = null;
  const h = acquire(socket, SID, (s) => { seen = s; });
  await settle();

  socket.push(EVENTS.PROMPT, { sessionId: SID, prompt: { promptId: "p1", kind: "permission" }, stale: true });

  assert.equal(seen.stale, true);
  assert.ok(seen.prompt, "the card must stay so the user can retry");
  release(socket, SID, h);
});

await test("releasing the last watcher tears the entry down", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  release(socket, SID, h);
  assert.equal(_entryCountForTest(), 0);
});

await test("a released watcher stops receiving updates", async () => {
  const socket = fakeSocket();
  let calls = 0;
  const a = acquire(socket, SID, () => { calls++; });
  const b = acquire(socket, SID, () => {});
  await settle();
  release(socket, SID, a);
  const before = calls;

  socket.push(EVENTS.PROMPT, { sessionId: SID, prompt: { promptId: "p2" } });

  assert.equal(calls, before, "an unmounted component being updated is a React warning at best");
  release(socket, SID, b);
});

await test("listeners are removed from the socket on teardown", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  assert.ok(socket.listenerCount(EVENTS.ACTIVITY) > 0);
  release(socket, SID, h);
  assert.equal(socket.listenerCount(EVENTS.ACTIVITY), 0, "a leaked listener keeps firing for every later session");
});

await test("a screen event updates the live indicator immediately", async () => {
  const socket = fakeSocket();
  let seen = null;
  const h = acquire(socket, SID, (s) => { seen = s; });
  await settle();

  socket.push(EVENTS.SCREEN, { sessionId: SID, live: { working: "Proofing", prompt: null, tool: "Bash" } });

  assert.equal(seen?.live?.working, "Proofing", "the spinner verb must not wait for a refetch");
  assert.equal(seen.live.tool, "Bash");
  release(socket, SID, h);
});

await test("a screen event for another session does not touch this one", async () => {
  const socket = fakeSocket();
  let seen = null;
  const h = acquire(socket, SID, (s) => { seen = s; });
  await settle();

  socket.push(EVENTS.SCREEN, { sessionId: "other", live: { working: "X" } });
  await settle();

  assert.equal(seen?.live, null);
  release(socket, SID, h);
});

await test("a screen listener is removed on teardown", async () => {
  const socket = fakeSocket();
  const h = acquire(socket, SID, () => {});
  await settle();
  assert.ok(socket.listenerCount(EVENTS.SCREEN) > 0);
  release(socket, SID, h);
  assert.equal(socket.listenerCount(EVENTS.SCREEN), 0);
});

await test("re-acquiring after a full release starts a fresh subscription", async () => {
  const socket = fakeSocket();
  const a = acquire(socket, SID, () => {});
  await settle();
  release(socket, SID, a);

  const b = acquire(socket, SID, () => {});
  await settle();
  assert.equal(socket.subscribeCount, 2);
  release(socket, SID, b);
});

await test("different sessions get independent entries", async () => {
  const socket = fakeSocket();
  const a = acquire(socket, "s1", () => {});
  const b = acquire(socket, "s2", () => {});
  await settle();
  assert.equal(socket.subscribeCount, 2);
  assert.equal(_entryCountForTest(), 2);
  release(socket, "s1", a);
  release(socket, "s2", b);
});

await test("acquire without a socket or session is a no-op", () => {
  const h = acquire(null, SID, () => {});
  assert.equal(_entryCountForTest(), 0);
  release(null, SID, h);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
