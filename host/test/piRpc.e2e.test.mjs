// e2e against the real `pi` binary (gated: set PI_E2E=1). Verifies the launch
// flow end to end: no ready handshake (pi answers commands immediately) →
// state/models/fork commands over the pipe → frames normalize through
// PiAdapter → clean exit on stdin close. No model call is made.
// Run: PI_E2E=1 node test/piRpc.e2e.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { OmpRpcClient } from "../features/ai/ompRpcClient.js";
import { PiAdapter } from "../features/ai/adapters/piAdapter.js";

if (!process.env.PI_E2E) {
  console.log("PI_E2E not set — skipping (set PI_E2E=1 to run against the real CLI).");
  process.exit(0);
}

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));

const proc = {
  onLine: null,
  write: (text) => { child.stdin.write(text); return true; },
  closeStdin: () => child.stdin.end(),
};
const rpc = new OmpRpcClient({ proc });

const events = [];
const adapter = new PiAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
adapter.rpc = rpc;

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  let at;
  while ((at = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (line.trim()) proc.onLine?.(line);
  }
});

console.log("Running pi RPC e2e...");
let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

await test("pi answers get_state without any ready handshake", async () => {
  const state = await rpc.send("get_state", {}, { timeoutMs: 20000 });
  assert.equal(typeof state?.isStreaming, "boolean");
});

await test("available models arrive shaped for the picker", async () => {
  const data = await rpc.send("get_available_models", {}, { timeoutMs: 30000 });
  const models = Array.isArray(data?.models) ? data.models : [];
  assert.ok(models.length > 0, "pi reports its model catalog");
  for (const m of models.slice(0, 5)) {
    assert.ok(m.id && m.provider, "model carries id + provider");
  }
});

await test("thinking levels respond to set_thinking_level", async () => {
  await rpc.send("set_thinking_level", { level: "low" }, { timeoutMs: 20000 });
  const state = await rpc.send("get_state", {}, { timeoutMs: 20000 });
  assert.equal(state.thinkingLevel, "low");
});

await test("session naming and fork listing round-trip", async () => {
  await rpc.send("set_session_name", { name: "9remote e2e" }, { timeoutMs: 20000 });
  const state = await rpc.send("get_state", {}, { timeoutMs: 20000 });
  assert.equal(state.sessionName, "9remote e2e");
  const forks = await rpc.send("get_fork_messages", {}, { timeoutMs: 20000 });
  assert.ok(Array.isArray(forks?.messages), "fork listing is a list (empty is fine)");
});

await test("adapter surfaces the state over the shared vocabulary", async () => {
  const state = await rpc.send("get_state", {}, { timeoutMs: 20000 });
  assert.ok(state.sessionId !== undefined);
  // _syncState is the same path the pane rides after spawn/adopt.
  adapter._syncState();
  await new Promise((r) => setTimeout(r, 500));
  const inits = events.filter(([e]) => e === "init");
  assert.ok(inits.length >= 1, "init event reached the pane vocabulary");
});

await test("/session answers from the real session stats", async () => {
  const rows = [];
  adapter.onEvent = (e, d) => rows.push([e, d]);
  adapter.sendPrompt("/session");
  for (let i = 0; i < 40 && !rows.some(([e, d]) => e === "cli_event" && d.subtype === "local_command"); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const row = rows.find(([e, d]) => e === "cli_event" && d.subtype === "local_command");
  assert.ok(row, "local command row emitted");
  assert.match(row[1].record.content, /Session .*\nMessages:/);
});

await test("clean exit on stdin close", async () => {
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi did not exit; stderr: ${stderr.slice(0, 400)}`)), 10000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    rpc.close();
  });
  assert.ok(code === 0 || code === null, `exit code ${code}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
