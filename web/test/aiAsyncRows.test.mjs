// A launch ack is not a result. These pin the two halves that make that true across the
// wire: the host must not report async work as `done`, and the client must not settle it
// when the turn that launched it ends.
import assert from "node:assert/strict";
import { asyncHandle } from "../../host/features/ai/toolEvent.js";
import { settleRunningTools, runningAgents, runningAsync } from "../features/ai/lib/toolTree.js";

// The real strings, copied off claude 2.1.270's stream-json output.
const AGENT_ACK = "[{\"type\":\"text\",\"text\":\"Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\\nagentId: a2f1c82e8a84ace4b (internal ID - do not mention to user. Use SendMessage with to: 'a2f1c82e8a84ace4b', summary: '<5-10 word recap>' to continue this agent.)\"}]";
const SHELL_ACK = "Command running in background with ID: b6bdgo9ez. Output is being written to: /private/tmp/claude-501/-Users-Working-9remote/tasks/b6bdgo9ez.output";

assert.deepEqual(asyncHandle(AGENT_ACK, "Agent"), { id: "a2f1c82e8a84ace4b", handle: true }, "agent ack names its agentId");
assert.deepEqual(asyncHandle(SHELL_ACK, "Bash"), { id: "b6bdgo9ez", handle: true }, "shell ack names its shell id");

// A result that merely CONTAINS an ack is not one. Verified on a real log: reading a file
// that quotes the shell ack marked the Read row as live work forever.
assert.equal(asyncHandle(SHELL_ACK, "Read"), null, "only a launcher tool can hand work off");
assert.equal(asyncHandle(AGENT_ACK, "TaskOutput"), null);

// An ordinary result must not be mistaken for a launch ack.
assert.equal(asyncHandle("(Bash completed with no output)", "Bash"), null);
assert.equal(asyncHandle("", "Bash"), null);
assert.equal(asyncHandle(undefined, "Bash"), null);

// The turn ends the instant the ack lands, so without this exception the strip would be
// emptied two events after it filled.
const agentRow = { id: "call_k0w30z5a", name: "Agent", status: "running", async: true, handle: "a2f1c82e8a84ace4b" };
const plainRow = { id: "call_other", name: "Bash", status: "running" };
const settled = settleRunningTools([agentRow, plainRow]);
assert.equal(settled[0].status, "running", "async work survives the end of its turn");
assert.equal(settled[1].status, "done", "everything else is still settled at the turn boundary");

// ...and the strip reads it, which is the whole point of keeping it running.
assert.deepEqual(runningAgents([{ tools: [agentRow] }]), [{ id: "call_k0w30z5a", label: "agent" }]);

// A background shell is the same shape one kind over: the CLI returned at once, the
// command did not. Its label is the command, not the word "Bash".
const shellRow = { id: "call_tk1xn81v", name: "Bash", status: "running", async: true, handle: "b6bdgo9ez", input: { description: "Background shell probe 90s" } };
assert.deepEqual(runningAsync([{ tools: [agentRow, shellRow] }]), [
  { kind: "agent", id: "call_k0w30z5a", label: "agent" },
  { kind: "shell", id: "call_tk1xn81v", label: "Background shell probe 90s" },
]);
// An ordinary Bash row is not work in flight, however it ended up marked.
assert.deepEqual(runningAsync([{ tools: [{ id: "b", name: "Bash", status: "running" }] }]), []);

// Children of an async row survive too (a sub-agent's own tool calls).
const nested = settleRunningTools([{ ...agentRow, children: [plainRow] }]);
assert.equal(nested[0].status, "running");
assert.equal(nested[0].children[0].status, "done", "the children are still settled");

// A row with children but no running status must keep its children, not drop them.
const doneParent = settleRunningTools([{ id: "p", status: "done", children: [plainRow] }]);
assert.equal(doneParent[0].children[0].status, "done");

console.log("aiAsyncRows: ok");
