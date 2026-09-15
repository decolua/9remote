// What an adopted claude process means for the turn flag.
//
// Run: node agent/test/claudeAdapterAdopt.test.mjs
//
// The CLI holds ONE process for a whole conversation and sits idle between turns, so a
// live process is not a running turn. Reading `alive` as "running" left the flag stuck
// true for the rest of the chat's life — a rewind then answered "Stop the running turn
// before rewinding." while nothing was running (reproduced on session-1789440076607).

import assert from "node:assert/strict";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

/** A carrier answer with the lines the reader fetches, in the daemon's own shape. */
const procWith = (lines) => ({
  lineNo: lines.length,
  epoch: 1,
  async attach() {
    return { alive: true, lines: lines.map((data, i) => ({ n: i + 1, data })), after: [], missed: 0, release: () => {} };
  }
});

const adapterWith = (lines) => new ClaudeAdapter({ cwd: process.cwd(), onEvent: () => {}, proc: procWith(lines) });

await test("an idle process is not a running turn", async () => {
  const a = adapterWith([JSON.stringify({ type: "result", subtype: "success" })]);
  await a.adopt(1, 1);
  assert.equal(a.isTurnRunning, false);
});

await test("a process mid-turn still counts as running", async () => {
  // The last thing it printed was a stream delta: the turn it belongs to never ended.
  const a = adapterWith([JSON.stringify({ type: "result" }), JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } })]);
  await a.adopt(2, 1);
  assert.equal(a.isTurnRunning, true);
});

await test("a gate the CLI is holding counts as running too", async () => {
  const a = adapterWith([JSON.stringify({ type: "control_request", request_id: "r1", request: { tool_name: "Bash" } })]);
  await a.adopt(1, 1);
  assert.equal(a.isTurnRunning, true);
});

await test("nothing to read means nothing is running", async () => {
  const a = adapterWith([]);
  await a.adopt(0, 1);
  assert.equal(a.isTurnRunning, false);
});

// A refused resume exits non-zero and the process is gone; the flag must not be set from
// a corpse either, whatever the last line said.
await test("a dead process leaves the turn idle", async () => {
  const proc = { lineNo: 0, epoch: null, async attach() { return { alive: false, lines: [], after: [], missed: 0, release: () => {} }; } };
  const a = new ClaudeAdapter({ cwd: process.cwd(), onEvent: () => {}, proc });
  await a.adopt(0, null);
  assert.equal(a.isTurnRunning, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
