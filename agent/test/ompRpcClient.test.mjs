// The omp RPC codec without omp: a fake stdio proc drives ready/negotiation,
// rpc_chunk reassembly, response correlation and UI replies.
// Run: node agent/test/ompRpcClient.test.mjs
import assert from "node:assert/strict";
import { OmpRpcClient } from "../features/ai/ompRpcClient.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

function fakeProc() {
  const state = { written: [], closed: false };
  const proc = {
    onLine: null,
    onExit: null,
    write: (text) => { state.written.push(text); return true; },
    closeStdin: () => { state.closed = true; },
  };
  return { proc, state, feed: (frame) => proc.onLine(JSON.stringify(frame) + "\n") };
}

console.log("Running omp RPC client tests...");

await test("ready auto-negotiates protocol v2", () => {
  const fake = fakeProc();
  const rpc = new OmpRpcClient({ proc: fake.proc });
  fake.feed({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
  const sent = JSON.parse(fake.state.written[0]);
  assert.equal(sent.type, "negotiate_protocol");
  assert.equal(sent.protocolVersion, 2);
});

await test("send → response round-trip resolves data", async () => {
  const fake = fakeProc();
  const rpc = new OmpRpcClient({ proc: fake.proc });
  const p = rpc.send("get_available_models");
  const sent = JSON.parse(fake.state.written.at(-1));
  assert.equal(sent.type, "get_available_models");
  fake.feed({ id: sent.id, type: "response", command: "get_available_models", success: true, data: { models: [{ id: "x" }] } });
  const data = await p;
  assert.deepEqual(data.models, [{ id: "x" }]);
});

await test("a failed response rejects with the server's error", async () => {
  const fake = fakeProc();
  const rpc = new OmpRpcClient({ proc: fake.proc });
  const p = rpc.send("set_model", { provider: "nope", modelId: "nope" });
  const sent = JSON.parse(fake.state.written.at(-1));
  fake.feed({ id: sent.id, type: "response", command: "set_model", success: false, error: "Model not found: nope/nope" });
  await assert.rejects(() => p, /Model not found/);
});

await test("a chunked frame larger than 1 MiB reassembles into one event", () => {
  const fake = fakeProc();
  const frames = [];
  const rpc = new OmpRpcClient({ proc: fake.proc });
  rpc.onFrame = (f) => frames.push(f);
  const big = { type: "agent_end", messages: [{ role: "assistant", content: "x".repeat(1200 * 1024) }] };
  const bytes = Buffer.from(JSON.stringify(big), "utf8");
  const CHUNK = 256 * 1024;
  const count = Math.ceil(bytes.length / CHUNK);
  for (let i = 0; i < count; i++) {
    fake.feed({ type: "rpc_chunk", chunkId: "rpc-1", index: i, count, byteLength: bytes.length, data: bytes.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64") });
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "agent_end");
  assert.equal(frames[0].messages[0].content.length, 1200 * 1024);
});

await test("an interrupted chunk sequence is discarded", () => {
  const fake = fakeProc();
  const frames = [];
  const rpc = new OmpRpcClient({ proc: fake.proc });
  rpc.onFrame = (f) => frames.push(f);
  const bytes = Buffer.from(JSON.stringify({ type: "agent_end", messages: [] }), "utf8");
  fake.feed({ type: "rpc_chunk", chunkId: "rpc-9", index: 0, count: 2, byteLength: 1048576 + 10, data: bytes.toString("base64") });
  // A different frame between chunks breaks the sequence by contract.
  fake.feed({ type: "notice", level: "info", message: "hi" });
  fake.feed({ type: "rpc_chunk", chunkId: "rpc-9", index: 1, count: 2, byteLength: 1048576 + 10, data: "" });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "notice");
});

await test("non-response frames reach onFrame untouched", () => {
  const fake = fakeProc();
  const frames = [];
  const rpc = new OmpRpcClient({ proc: fake.proc });
  rpc.onFrame = (f) => frames.push(f);
  fake.feed({ type: "available_commands_update", commands: [{ name: "review", description: "d", source: "builtin" }] });
  fake.feed({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] });
  assert.equal(frames.length, 2);
  rpc.uiRespondValue("ui-1", "Approve");
  const sent = JSON.parse(fake.state.written.at(-1));
  assert.deepEqual(sent, { type: "extension_ui_response", id: "ui-1", value: "Approve" });
});

await test("close drains pending with an error", async () => {
  const fake = fakeProc();
  const rpc = new OmpRpcClient({ proc: fake.proc });
  const p = rpc.send("prompt", { message: "x" }, { timeoutMs: 5000 });
  rpc.close();
  await assert.rejects(() => p, /closed/);
  assert.equal(fake.state.closed, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
