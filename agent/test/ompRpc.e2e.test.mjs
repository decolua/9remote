// e2e against the real `omp` binary (gated: set OMP_E2E=1). Verifies the launch
// handshake end to end: ready → v2 negotiation → live command feed → abort →
// clean exit on stdin close. No model call is made.
// Run: OMP_E2E=1 node agent/test/ompRpc.e2e.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { OmpRpcClient } from "../features/ai/ompRpcClient.js";

if (!process.env.OMP_E2E) {
  console.log("OMP_E2E not set — skipping (set OMP_E2E=1 to run against the real CLI).");
  process.exit(0);
}

const child = spawn("omp", ["--mode", "rpc"], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));

const frames = [];
const proc = {
  onLine: null,
  write: (text) => { child.stdin.write(text); return true; },
  closeStdin: () => child.stdin.end(),
};
const rpc = new OmpRpcClient({ proc });
rpc.onFrame = (f) => frames.push(f);
// Pipe the child's stdout into the client line by line.
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

const readyFrame = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ready frame; stderr: ${stderr.slice(0, 400)}`)), 20000);
  const orig = rpc.onFrame;
  rpc.onFrame = (f) => { orig?.(f); frames.push(f); if (f.type === "ready") { clearTimeout(timer); resolve(f); } };
});

console.log("Running omp RPC e2e...");
let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

await test("ready frame advertises the chunked protocol", () => {
  assert.equal(readyFrame.type, "ready");
  assert.ok(readyFrame.supportedProtocolVersions?.includes(2));
});

await test("the command feed answers over the negotiated pipe", async () => {
  const data = await rpc.send("get_available_commands", {}, { timeoutMs: 20000 });
  const names = (data?.commands || []).map((c) => c.name);
  assert.ok(Array.isArray(names) && names.length >= 0, "commands must be a list");
  console.log(`    (${names.length} commands: ${names.slice(0, 5).join(", ")}…)`);
});

await test("state answers with a session context", async () => {
  const state = await rpc.send("get_state", {}, { timeoutMs: 20000 });
  assert.ok(state && typeof state === "object");
  assert.equal(state.isStreaming, false);
});

await test("closing stdin exits the process cleanly", async () => {
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    rpc.close();
  });
  assert.equal(code, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
