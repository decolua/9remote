// Unit tests for the daemon's route layer (features/terminal/daemonRouter.js).
// Run: node agent/test/daemonRouter.test.mjs
//
// The daemon is one long-lived process serving every terminal and chat, so the two
// properties that keep it honest are: a message is dispatched exactly once, in order,
// and nothing else runs while a handler is still working (single-threaded dispatch —
// that is what makes an interleaved input/resize pair unable to race).
import assert from "node:assert/strict";
import { createRouter } from "../features/terminal/daemonRouter.js";
import { ROUTES, ALIASES, resolveRoute } from "../features/terminal/daemonRoutes.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// A router over a log of what actually ran, with no daemon internals involved.
function makeRouter(handlers = {}) {
  const ran = [];
  const replies = [];
  const deps = { log: (...a) => ran.push(a) };
  const router = createRouter({ deps, send: (client, msg) => replies.push(msg) });
  router.register("terminal", handlers.terminal || {});
  router.register("proc", handlers.proc || {});
  // A message arrives on a socket; answering needs one. Only the "client went away"
  // test passes null on purpose.
  const client = { id: 1 };
  return { router, ran, replies, client };
}

console.log("Running daemon router tests...");

await test("a domain route reaches its handler with the payload", async () => {
  const { router, ran, replies, client } = makeRouter({
    terminal: { input: (p) => { ran.push(["input", p.sessionId, p.data]); return {}; } }
  });
  router.enqueue({ client, message: { type: "terminal.input", sessionId: "s1", data: "x", requestId: 7 } });
  await tick();
  assert.deepEqual(ran, [["input", "s1", "x"]]);
  // input is fire-and-forget: it declares no result, so it must not answer at all.
  assert.deepEqual(replies, []);
});

await test("a route that declares a result answers on its own requestId", async () => {
  const { router, replies, client } = makeRouter({
    proc: { start: () => ({ success: true, procId: "p1" }) }
  });
  router.enqueue({ client, message: { type: "proc.start", procId: "p1", requestId: 11 } });
  await tick();
  assert.deepEqual(replies, [{ type: "procStartResult", success: true, procId: "p1", requestId: 11 }]);
});

await test("an old wire name still routes (a new daemon must serve old agents)", async () => {
  // The names shipped before the router existed cannot be renamed without killing
  // every live terminal, so they are aliases rather than new routes.
  const { router, ran, client } = makeRouter({
    terminal: { joinSession: (p) => { ran.push(["join", p.sessionId]); return {}; } }
  });
  router.enqueue({ client, message: { type: "joinSession", sessionId: "s2" } });
  await tick();
  assert.deepEqual(ran, [["join", "s2"]]);
  assert.equal(resolveRoute("joinSession"), "terminal.joinSession");
});

await test("every alias points at a route that exists", async () => {
  // A typo here is a dead wire name — the agent waits out its 5s timeout for an answer
  // that can never come.
  for (const [alias, target] of Object.entries(ALIASES)) {
    assert.ok(ROUTES[target], `alias "${alias}" points at unknown route "${target}"`);
  }
});

await test("an unknown route fails fast instead of timing out", async () => {
  const { router, replies, client } = makeRouter({});
  router.enqueue({ client, message: { type: "nope.nothing", requestId: 3 } });
  await tick();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestId, 3);
  assert.match(replies[0].error, /Unknown route/);
});

await test("messages are dispatched in order, one at a time", async () => {
  // Single-threaded: a slow handler must finish before the next message starts, or two
  // handlers can interleave on the same session.
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { router, client } = makeRouter({
    terminal: {
      slow: async () => { order.push("slow:start"); await gate; order.push("slow:end"); return {}; },
      fast: () => { order.push("fast"); return {}; },
    }
  });
  router.enqueue({ client, message: { type: "terminal.slow", requestId: 1 } });
  router.enqueue({ client, message: { type: "terminal.fast", requestId: 2 } });
  await tick();
  assert.deepEqual(order, ["slow:start"], "the second message ran while the first was still working");
  release();
  await tick();
  assert.deepEqual(order, ["slow:start", "slow:end", "fast"]);
});

await test("a slow handler cannot delay a different session's ack into the wrong one", async () => {
  // Answers carry the requestId of the message that caused them; a queue that reused
  // one would hand session A's reply to session B.
  const { router, replies, client } = makeRouter({
    terminal: {
      joinSession: async () => { await tick(); return { who: "a" }; },
      getCwd: () => ({ who: "b" }),
    }
  });
  router.enqueue({ client, message: { type: "terminal.joinSession", requestId: 100 } });
  router.enqueue({ client, message: { type: "terminal.getCwd", requestId: 200 } });
  await tick(); await tick(); await tick();
  assert.deepEqual(replies.map((r) => [r.who, r.requestId]), [["a", 100], ["b", 200]]);
});

await test("a coalescing route collapses a burst to its last message", async () => {
  // Resize is idempotent: only the final size matters, and a drag produces dozens of
  // them. Sending all of them makes the PTY re-wrap for intermediate widths — and a
  // narrow intermediate size damages the scrollback permanently.
  const ran = [];
  const { router, client } = makeRouter({ terminal: { resize: (p) => { ran.push(p.cols); return {}; } } });
  for (const cols of [10, 80, 120, 200]) {
    router.enqueue({ client, message: { type: "terminal.resize", sessionId: "s1", cols, rows: 30 } });
  }
  await tick();
  assert.deepEqual(ran, [200]);
});

await test("coalescing is per session and never crosses routes", async () => {
  const ran = [];
  const { router, client } = makeRouter({
    terminal: {
      resize: (p) => { ran.push(["resize", p.sessionId, p.cols]); return {}; },
      input: (p) => { ran.push(["input", p.sessionId, p.data]); return {}; },
    }
  });
  router.enqueue({ client, message: { type: "terminal.resize", sessionId: "s1", cols: 100, rows: 30 } });
  router.enqueue({ client, message: { type: "terminal.resize", sessionId: "s2", cols: 101, rows: 30 } });
  router.enqueue({ client, message: { type: "terminal.resize", sessionId: "s1", cols: 140, rows: 30 } });
  router.enqueue({ client, message: { type: "terminal.input", sessionId: "s1", data: "a" } });
  router.enqueue({ client, message: { type: "terminal.input", sessionId: "s1", data: "b" } });
  await tick();
  // s1's two resizes collapse to the newest; s2's is untouched; both inputs survive in
  // order — typing must never be merged away.
  assert.deepEqual(ran, [["resize", "s1", 140], ["resize", "s2", 101], ["input", "s1", "a"], ["input", "s1", "b"]]);
});

await test("a handler that throws answers with the error, not a hang", async () => {
  const { router, replies, client } = makeRouter({
    proc: { start: () => { throw new Error("spawn exploded"); } }
  });
  router.enqueue({ client, message: { type: "proc.start", requestId: 5 } });
  await tick();
  assert.deepEqual(replies, [{ type: "procStartResult", success: false, error: "spawn exploded", requestId: 5 }]);
});

await test("the dispatcher keeps running after a handler throws", async () => {
  const ran = [];
  const { router, client } = makeRouter({
    proc: {
      start: () => { throw new Error("boom"); },
      stop: (p) => { ran.push(["stop", p.procId]); return {}; },
    }
  });
  router.enqueue({ client, message: { type: "proc.start", requestId: 1 } });
  router.enqueue({ client, message: { type: "proc.stop", procId: "p9", requestId: 2 } });
  await tick(); await tick();
  assert.deepEqual(ran, [["stop", "p9"]]);
});

await test("a failed fire-and-forget route still answers — silence would hide it", async () => {
  // input/resize declare no reply, so success is silent (an ack per keystroke is pure
  // overhead). A FAILURE is not the same thing: without an answer the caller watches
  // its input vanish and is told nothing.
  const { router, replies, client } = makeRouter({
    terminal: { input: () => ({ success: false, error: "Session not found" }) }
  });
  router.enqueue({ client, message: { type: "terminal.input", sessionId: "gone", requestId: 9 } });
  await tick();
  assert.equal(replies.length, 1, "the failure was swallowed");
  assert.equal(replies[0].error, "Session not found");
  assert.equal(replies[0].requestId, 9);
});

await test("a successful fire-and-forget route stays silent", async () => {
  const { router, replies, client } = makeRouter({ terminal: { input: () => ({}) } });
  router.enqueue({ client: { id: 1 }, message: { type: "terminal.input", sessionId: "s1", data: "x" } });
  await tick();
  assert.deepEqual(replies, []);
});

await test("a wedged handler locks its session instead of running beside the next one", async () => {
  // Nothing in JavaScript can cancel a running async function, so a timeout cannot undo
  // the work in flight. What it CAN do is refuse to start a second handler on the same
  // session — two handlers interleaved on one session is the failure single-threading
  // exists to prevent.
  const ran = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { router, replies, client } = makeRouter({
    terminal: {
      joinSession: async (p) => { ran.push(["join", p.sessionId]); await gate; return {}; },
      getCwd: (p) => { ran.push(["cwd", p.sessionId]); return {}; },
    }
  });
  router.enqueue({ client: { id: 1 }, message: { type: "terminal.joinSession", sessionId: "s1", requestId: 1, timeout: 20 } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(replies.length, 1);
  assert.match(replies[0].error, /timeout/i);

  // Same session → refused while the first is still stuck.
  router.enqueue({ client: { id: 1 }, message: { type: "terminal.getCwd", sessionId: "s1", requestId: 2 } });
  await tick();
  assert.equal(ran.filter((r) => r[0] === "cwd").length, 0, "a second handler ran on a locked session");

  // A DIFFERENT session is unaffected — one stuck session must not freeze the daemon.
  router.enqueue({ client: { id: 1 }, message: { type: "terminal.getCwd", sessionId: "s2", requestId: 3 } });
  await tick();
  assert.deepEqual(ran.filter((r) => r[0] === "cwd"), [["cwd", "s2"]]);

  release();
  await tick();
  // Once it settles the session is usable again.
  router.enqueue({ client: { id: 1 }, message: { type: "terminal.getCwd", sessionId: "s1", requestId: 4 } });
  await tick();
  assert.ok(ran.some((r) => r[0] === "cwd" && r[1] === "s1"));
});

await test("a message from a client that has gone away is dropped, not thrown on", async () => {
  const { router, client } = makeRouter({ terminal: { ping: () => ({ version: "x" }) } });
  // Would throw on client.write without the guard.
  router.enqueue({ client: null, message: { type: "terminal.ping", requestId: 1 } });
  await tick();
  router.enqueue({ client: null, message: { type: "terminal.nope", requestId: 2 } });
  await tick();
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
