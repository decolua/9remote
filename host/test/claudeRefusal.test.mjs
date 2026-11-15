// A prompt the CLI never accepted must not vanish behind a lit turn flag.
// Run: node host/test/claudeRefusal.test.mjs
//
// The daemon, not the adapter, decides a write landed; a refusal on the retried
// send used to do nothing at all: isTurnRunning stayed true and the pane waited
// forever over a prompt no turn would ever answer.
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";

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

// start() never runs in these tests — the adapter only needs a proc-shaped object.
const fakeProc = {
  start: async () => ({ commit() {}, release() {}, lines: [], after: [] }),
  write: () => true
};

const makeAdapter = (events) => new ClaudeAdapter({
  cwd: "/tmp",
  onEvent: (event, data) => events.push({ event, data }),
  proc: fakeProc
});

// Every write is refused: the daemon turned it away, so the bytes never arrived.
const refusingRpc = () => ({
  notify: (method, params, onRefused) => { onRefused?.(); return true; }
});

await test("a refusal on the retried send is surfaced, not swallowed", async () => {
  const events = [];
  const adapter = makeAdapter(events);
  adapter.rpc = refusingRpc();

  adapter._send("hi", null, true, "p-retry");

  assert.equal(adapter.isTurnRunning, false, "the turn flag must not stay lit");
  const error = events.find((e) => e.event === "error");
  assert.ok(error, "a second refusal must be visible to the pane");
  assert.equal(error.data.promptId, "p-retry", "the id rides along so the host can release it");
});

await test("a refusal with no recovery left carries the prompt id", async () => {
  const events = [];
  const adapter = makeAdapter(events);
  adapter.resumeRejected = true;
  adapter.rpc = refusingRpc();

  adapter._send("hi", null, false, "p-first");

  assert.equal(adapter.isTurnRunning, false);
  const error = events.find((e) => e.event === "error");
  assert.equal(error?.data?.promptId, "p-first");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
