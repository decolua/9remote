// opencodePart mapping: message parts → pane events. Focus: a rejected question
// tool must settle as a visible skip, never a "done" row with no output.
// Run: node agent/test/opencodePart.test.mjs
import assert from "node:assert/strict";
import { opencodePartEvents } from "../features/ai/opencodePart.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running opencode part tests...");

const of = (events, name) => events.filter((ev) => ev.event === name).map((ev) => ev.data);

test("a running part announces the card only", () => {
  const events = opencodePartEvents({ tool: "bash", callID: "c1", state: { status: "running", input: { command: "ls" } } });
  assert.equal(of(events, "tool_start").length, 1);
  assert.equal(of(events, "tool_result").length, 0);
});

test("a rejected question settles as a skip, not an empty done", () => {
  const events = opencodePartEvents({ tool: "question", callID: "c2", state: { status: "error", input: { questions: [] }, output: "" } });
  const [res] = of(events, "tool_result");
  assert.equal(res.status, "error");
  assert.equal(res.error, "User skipped this request");
});

test("a silent error on any other tool names itself", () => {
  const events = opencodePartEvents({ tool: "bash", callID: "c3", state: { status: "error", input: {}, output: "" } });
  const [res] = of(events, "tool_result");
  assert.equal(res.error, "Tool failed.");
});

test("an error with text keeps its own words", () => {
  const events = opencodePartEvents({ tool: "read", callID: "c4", state: { status: "error", input: {}, output: "file missing" } });
  const [res] = of(events, "tool_result");
  assert.equal(res.error, "file missing");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
