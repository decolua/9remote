// The standalone conductor's loop: a provider-neutral function-calling turn.
// The wire call is injected ({text, calls} in, neutral turns out), so these run
// the real loop — tool dispatch, id correlation, hop cap, history — offline; the
// three wire-format converters are tested against their real target shapes.
//
// Run: node agent/test/jarvisAgent.test.mjs
import assert from "node:assert/strict";
import {
  resetAgentForTests, setAgentConfig, loadAgentConfig, agentStatus, jarvisTurn, chatHistory,
  toGeminiContents, toOpenAiMessages, toAnthropicMessages, toNeutral, openAiStreamAccumulator,
  setAgentKvForTests
} from "../features/jarvis/jarvisAgent.js";

// In-memory KV — these tests never touch the user's real daemon store.
const kvStore = new Map();
setAgentKvForTests({
  get: async (key) => (kvStore.has(key) ? structuredClone(kvStore.get(key)) : null),
  set: async (key, value) => { kvStore.set(key, structuredClone(value)); }
});

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("Running jarvis standalone agent tests...");

test("no key is an honest error, not a network attempt", async () => {
  resetAgentForTests();
  const res = await jarvisTurn("giao việc đi");
  assert.match(res.error, /API key/);
});

test("a plain answer turn: one wire call, the text comes back, history persists", async () => {
  const calls = [];
  resetAgentForTests({ generate: async (turns) => {
    calls.push([...turns]); // snapshot — the live array keeps growing after
    return { text: "Đang có 2 session rảnh.", calls: [] };
  } });
  setAgentConfig({ apiKey: "k" });
  const events = [];
  const res = await jarvisTurn("ai đang rảnh?", (type, data) => events.push([type, data]));
  assert.equal(res.error, undefined);
  assert.match(res.text, /rảnh/);
  assert.equal(calls.length, 1, "one wire call");
  assert.equal(calls[0].at(-1).role, "user");
  assert.equal(events.filter(([t]) => t === "assistant").length, 1);
  const history = await chatHistory();
  assert.equal(history.length, 2, "user + assistant persisted");
});

test("a tool turn: the call runs, ids ride back, the next hop sees the results", async () => {
  const wireTurns = [];
  const replies = [
    { text: "", calls: [{ id: "call-1", name: "list_fleet", args: {} }] },
    { text: "Có 2 session.", calls: [] }
  ];
  resetAgentForTests({ generate: async (turns) => {
    wireTurns.push([...turns]); // snapshot — the live array keeps growing after
    return replies.shift();
  } });
  setAgentConfig({ apiKey: "k" });
  const events = [];
  const res = await jarvisTurn("cho tôi biết fleet", (type, data) => events.push([type, data]));
  assert.equal(res.error, undefined);
  assert.equal(wireTurns.length, 2, "two hops");
  // The tool turn carries the id the model named — openai/anthropic correlate by it.
  const toolTurn = wireTurns[1].at(-1);
  assert.equal(toolTurn.role, "tool");
  assert.equal(toolTurn.results[0].callId, "call-1");
  assert.equal(toolTurn.results[0].name, "list_fleet");
  assert.ok(JSON.stringify(toolTurn.results[0].output).length > 0, "a real fleet read");
  assert.ok(events.some(([t, d]) => t === "tool" && d.name === "list_fleet"));
  assert.ok(events.some(([t]) => t === "toolResult"));
});

test("a runaway model is stopped at the hop cap with an honest note", async () => {
  resetAgentForTests({ generate: async () => ({ text: "", calls: [{ id: "c", name: "list_fleet", args: {} }] }) });
  setAgentConfig({ apiKey: "k" });
  const res = await jarvisTurn("lặp mãi đi");
  assert.equal(res.error, undefined);
  assert.match(res.text, /loop limit/);
});

test("a busy agent refuses a second concurrent turn", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resetAgentForTests({ generate: async () => {
    await gate;
    return { text: "xong", calls: [] };
  } });
  setAgentConfig({ apiKey: "k" });
  const first = jarvisTurn("turn chậm", () => {});
  await sleep(10);
  const second = await jarvisTurn("turn chen ngang", () => {});
  assert.match(second.error, /already running/);
  release();
  const done = await first;
  assert.equal(done.error, undefined);
  assert.equal(agentStatus().busy, false, "busy cleared after the turn");
});

// ── The three wire formats, from one neutral conversation ──
const CONVO = [
  { role: "user", text: "tạo task demo" },
  { role: "assistant", text: "đã rõ", calls: [{ id: "call-9", name: "create_session", args: { engine: "claude" } }] },
  { role: "tool", results: [{ callId: "call-9", name: "create_session", output: { sessionId: "s-1" } }] }
];

test("gemini contents: model parts carry functionCall, tool results are user functionResponse", () => {
  const contents = toGeminiContents(CONVO);
  assert.equal(contents[0].role, "user");
  const model = contents[1];
  assert.equal(model.role, "model");
  assert.equal(model.parts[0].text, "đã rõ");
  assert.equal(model.parts[1].functionCall.name, "create_session");
  const tool = contents[2];
  assert.equal(tool.role, "user");
  assert.equal(tool.parts[0].functionResponse.name, "create_session");
  assert.deepEqual(tool.parts[0].functionResponse.response, { sessionId: "s-1" });
});

test("openai messages: system first, tool_calls with stringified args, tool replies keyed by id", () => {
  const messages = toOpenAiMessages(CONVO);
  assert.equal(messages[0].role, "system");
  const assistant = messages[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls[0].id, "call-9");
  assert.equal(assistant.tool_calls[0].function.name, "create_session");
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).engine, "claude");
  const tool = messages[3];
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "call-9");
  assert.equal(JSON.parse(tool.content).sessionId, "s-1");
});

test("anthropic messages: tool_use blocks in, tool_result keyed by tool_use_id", () => {
  const messages = toAnthropicMessages(CONVO);
  const assistant = messages[1];
  assert.equal(assistant.role, "assistant");
  const use = assistant.content.find((b) => b.type === "tool_use");
  assert.equal(use.id, "call-9");
  assert.equal(use.name, "create_session");
  const result = messages[2];
  assert.equal(result.role, "user");
  assert.equal(result.content[0].type, "tool_result");
  assert.equal(result.content[0].tool_use_id, "call-9");
});

test("old gemini-parts history loads as neutral", () => {
  const legacy = [
    { role: "user", parts: [{ text: "legacy hỏi" }] },
    { role: "model", parts: [{ text: "trả lời" }, { functionCall: { name: "list_fleet", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "list_fleet", response: { result: "[]" } } }] }
  ];
  const neutral = legacy.map(toNeutral).filter(Boolean);
  assert.deepEqual(neutral[0], { role: "user", text: "legacy hỏi" });
  assert.equal(neutral[1].calls[0].name, "list_fleet");
  assert.equal(neutral[2].role, "tool");
  assert.equal(neutral[2].results[0].name, "list_fleet");
});

test("openai stream fragments merge: text pieces, tool_call id/name once, arguments trickle", () => {
  const acc = openAiStreamAccumulator();
  acc.push({ content: "Đang có " });
  acc.push({ tool_calls: [{ index: 0, id: "call-9", function: { name: "list_fleet", arguments: "" } }] });
  acc.push({ content: "2 session." });
  acc.push({ tool_calls: [{ index: 0, function: { arguments: '{"work' } }] });
  acc.push({ tool_calls: [{ index: 1, id: "call-a", function: { name: "close_session", arguments: '{"sessionId":"s1' } }] });
  acc.push({ tool_calls: [
    { index: 0, function: { arguments: 'spacePath":"/a"}' } },
    { index: 1, function: { arguments: '"}' } }
  ] });
  const { text, calls } = acc.result();
  assert.equal(text, "Đang có 2 session.");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { id: "call-9", name: "list_fleet", args: { workspacePath: "/a" } });
  assert.deepEqual(calls[1], { id: "call-a", name: "close_session", args: { sessionId: "s1" } });
});

test("config survives an agent restart: persist then load back", async () => {
  resetAgentForTests();
  setAgentConfig({ provider: "openai", baseUrl: "http://localhost:20128/v1/", apiKey: "sk-x", model: "ag/m" });
  resetAgentForTests(); // the restart wipes memory
  assert.equal(agentStatus().provider, "gemini", "memory reset to defaults");
  await loadAgentConfig();
  const status = agentStatus();
  assert.equal(status.provider, "openai");
  assert.equal(status.baseUrl, "http://localhost:20128/v1"); // trailing slash trimmed
  assert.equal(status.model, "ag/m");
  assert.equal(status.ready, true); // key restored, never exposed
});

for (const { name, fn } of cases) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
