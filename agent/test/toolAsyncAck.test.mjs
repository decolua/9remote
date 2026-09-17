// Which tool results name work that outlives the call.
//
// The CLI returns the moment work is handed off, naming a handle it will report on later.
// The pane keeps such a row RUNNING — the agent strip and the shell chip show work that is
// genuinely still in flight — so a launcher missing from this list closes its row while
// the work it started carries on, with nothing on screen to say so.
//
// Measured on one machine's transcripts: `Monitor` returned "Monitor started (task
// b301ffx4j, timeout 600000ms)…" 44 times, and every one of those rows was closed
// immediately because the tool was not in the list.
//
// Run: node agent/test/toolAsyncAck.test.mjs
import assert from "node:assert/strict";
import { asyncHandle } from "../features/ai/toolEvent.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("a Monitor's start ack names the task it will report on", () => {
  const out = "Monitor started (task b301ffx4j, timeout 600000ms). You will be notified on each event. Keep working — do not poll or sleep.";
  assert.deepEqual(asyncHandle(out, "Monitor"), { id: "b301ffx4j", handle: true });
});

test("the background-shell and sub-agent acks still work", () => {
  assert.equal(asyncHandle("Command running in background with ID: abc123", "Bash")?.id, "abc123");
  assert.equal(asyncHandle("Async agent launched successfully.\nagentId: agent-7", "Agent")?.id, "agent-7");
});

test("a result that merely QUOTES an ack is not one", () => {
  // The gate is the tool NAME: a Read of a file containing the phrase otherwise marks its
  // row as live work forever. Verified against a real log, where two Reads matched the
  // shell pattern exactly that way.
  const quoted = "Monitor started (task b301ffx4j, timeout 600000ms).";
  assert.equal(asyncHandle(quoted, "Read"), null);
  assert.equal(asyncHandle(quoted, "Grep"), null);
});

test("an ordinary result is not an ack, whoever ran it", () => {
  for (const name of ["Monitor", "Bash", "Agent", "Task"]) {
    assert.equal(asyncHandle("total 4\nfile.txt", name), null, name);
    assert.equal(asyncHandle("", name), null, name);
  }
});

// ── through the ADAPTER, on a real record ──
//
// The unit above proves the pattern; this proves the wire. The adapter looks the tool name
// up from the call it kept, so a name it never stored would make the pattern useless — and
// the row would close while the monitor kept running.

test("a Monitor's ack leaves its row running on the wire", async () => {
  const { ClaudeAdapter } = await import("../features/ai/adapters/claudeAdapter.js");
  const events = [];
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  // The CLI's own records, verbatim in shape: the call, then its result.
  adapter.handleMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_m1", name: "Monitor", input: { command: "until …", description: "watch the sweep" } }]
    }
  });
  adapter.handleMessage({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: "call_m1",
        content: [{ type: "text", text: "Monitor started (task b301ffx4j, timeout 600000ms). You will be notified on each event." }]
      }]
    }
  });
  const [result] = events.filter(([e]) => e === "tool_result").map(([, d]) => d);
  assert.ok(result, "the result reached the pane");
  assert.equal(result.status, "running", "a task that was handed off is still running");
  assert.equal(result.async, true);
  assert.equal(result.handle, "b301ffx4j", "and the handle it named rides along");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
