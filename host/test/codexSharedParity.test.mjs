// Codex app-server: what N parallel processes give each chat today, and what a
// shared single process must preserve (or fix) to reach parity.
//
// Run: node agent/test/codexSharedParity.test.mjs
//
// Part 1 (baseline) pins the per-chat feature list against the CURRENT one-
// process-per-chat wiring — a shared server must keep every one of these green
// unchanged. Part 2 (sharing gaps) asserts the places where today's code is NOT
// thread-isolated; these pass BY PROVING THE GAP, and each names the fix the
// shared demux owes before codex may ride one process like opencode does.
//
// Verified live against codex-cli 0.155.1 (one process, two threads): every
// stream frame carries threadId — item/*, turn/*, tokenUsage, hook/* — AND the
// approval requests do too (item/commandExecution/requestApproval carries
// threadId + turnId + itemId). Only process-level broadcasts lack it
// (deprecationNotice, account/rateLimits, remoteControl, thread/started — whose
// params.thread.id nests the id). No unknowns remain for a shared server.

import assert from "node:assert/strict";
import { CodexAppServer } from "../features/ai/proc/codexAppServer.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

/** Fake carrier that records writes and auto-answers named requests. */
const fakeProc = (replies = {}) => {
  const p = {
    written: [],
    onLine: null, onExit: null, onRefused: null,
    push(msg) { p.onLine?.(typeof msg === "string" ? msg : JSON.stringify(msg)); },
    exit(info = { code: 0 }) { p.onExit?.(info); },
    write(text) {
      const msg = JSON.parse(text);
      p.written.push(msg);
      const reply = replies[msg.method];
      if (msg.id != null && reply) p.push({ jsonrpc: "2.0", id: msg.id, result: reply(msg.params || {}, msg.id) });
      return true;
    }
  };
  return p;
};

const TH_A = "th-chat-a";
const TH_B = "th-chat-b";

/** One chat as it runs today: its own process, its own app-server. */
const makeChat = ({ threadId = null, cwd = "/w/a", model = "" } = {}) => {
  const events = [];
  const proc = fakeProc({
    initialize: () => ({}),
    "thread/start": () => ({ thread: { id: TH_A } }),
    "thread/resume": () => ({ thread: { id: threadId } }),
    "thread/settings/update": () => ({}),
    "turn/start": () => ({ turn: { id: "turn-1" } }),
    "turn/interrupt": () => ({})
  });
  const server = new CodexAppServer({ proc, cwd, threadId, model, mode: "default", onEvent: (e, d) => events.push([e, d]) });
  return { proc, server, events };
};

// ── Part 1: the per-chat contract a shared server must keep ──────────────────

await test("start: initialize once, then a thread born with THIS chat's cwd/model", async () => {
  const { proc, server } = makeChat({ cwd: "/w/a", model: "gpt-5" });
  await server.start();
  const methods = proc.written.map((m) => m.method);
  assert.deepEqual(methods.slice(0, 2), ["initialize", "thread/start"]);
  assert.equal(methods.filter((m) => m === "initialize").length, 1, "initialize is a process-level handshake — one per boot, not per thread");
  const started = proc.written.find((m) => m.method === "thread/start").params;
  assert.equal(started.cwd, "/w/a", "cwd rides the thread, not the process");
  assert.equal(started.model, "gpt-5");
  assert.ok(started.sandboxPolicy && started.approvalPolicy, "sandbox + approval ride the thread too");
});

await test("resume: a restarted chat reopens its own thread", async () => {
  const { server, proc } = makeChat({ threadId: TH_B });
  await server.start();
  const resumed = proc.written.find((m) => m.method === "thread/resume");
  assert.equal(resumed.params.threadId, TH_B);
  assert.equal(server.threadId, TH_B);
});

await test("events route by threadId — a foreign thread's delta never lands", async () => {
  const { server, events } = makeChat({});
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: TH_B, delta: "not mine" } }));
  assert.equal(events.length, 0, "another chat's stream is invisible here");
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: server.threadId, delta: "mine" } }));
  assert.deepEqual(events.at(-1), ["delta", { text: "mine" }]);
});

await test("interrupt targets this chat's thread and turn only", async () => {
  const { server, proc } = makeChat({ threadId: TH_A });
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: TH_A, turn: { id: "turn-9" } } }));
  assert.equal(server.interrupt(), true);
  const irq = proc.written.find((m) => m.method === "turn/interrupt");
  assert.deepEqual({ threadId: irq.params.threadId, turnId: irq.params.turnId }, { threadId: TH_A, turnId: "turn-9" });
});

await test("an approval gate opens for this thread and answers with its raw id", async () => {
  const { server, events, proc } = makeChat({ threadId: TH_A });
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "execCommandApproval", params: { threadId: TH_A, command: "rm -rf /tmp/x" } }));
  assert.equal(events.at(-1)[0], "permission_request");
  assert.equal(server.resolvePermission("7", "allow"), true);
  const answer = proc.written.find((m) => m.id === 7);
  assert.deepEqual(answer.result, { decision: "accept" }, "the wire id type survives the round trip");
});

await test("settings update and turn overrides carry the thread's own knobs", async () => {
  const { server, proc } = makeChat({ threadId: TH_A });
  await server.start();
  const changed = server.applyOptions({ mode: "fullAccess", model: "gpt-5-codex" });
  await server.updateSettings(changed);
  const upd = proc.written.find((m) => m.method === "thread/settings/update");
  assert.equal(upd.params.threadId, TH_A);
  assert.equal(upd.params.model, "gpt-5-codex");
  await server.sendPrompt("go");
  const turn = proc.written.find((m) => m.method === "turn/start");
  assert.equal(turn.params.threadId, TH_A);
  assert.equal(turn.params.model, "gpt-5-codex", "per-turn overrides stay per-thread");
});

await test("turn/completed ends the turn; an interrupt's echo settles without one", async () => {
  const { server, events } = makeChat({ threadId: TH_A });
  await server.start();
  let settled = 0;
  server.onInterruptSettled = () => settled++;
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: TH_A, turn: { id: "turn-1" } } }));
  server.interrupt();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: TH_A, turn: { status: "completed" } } }));
  assert.equal(settled, 1, "the interrupted turn settles instead of completing");
  assert.equal(events.some(([e]) => e === "turn_complete"), false);
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: TH_A, turn: { status: "completed" } } }));
  assert.equal(events.at(-1)[0], "turn_complete", "a clean turn still completes");
});

await test("process exit reports an errored turn, not a clean finish", async () => {
  const { server, proc, events } = makeChat({ threadId: TH_A });
  await server.start();
  proc.exit({ code: 1 });
  const last = events.at(-1);
  assert.equal(last[0], "turn_complete");
  assert.equal(last[1].isError, true);
});

// ── Part 2: sharing gaps — these pass BY PROVING THE GAP ─────────────────────

await test("GAP: one process cannot host two app-servers — onLine is a single slot", async () => {
  const shared = fakeProc({ initialize: () => ({}), "thread/start": (p) => ({ thread: { id: p.dummy || TH_A } }) });
  const a = new CodexAppServer({ proc: shared, cwd: "/w/a", threadId: TH_A, mode: "default", onEvent: () => {} });
  const b = new CodexAppServer({ proc: shared, cwd: "/w/b", threadId: TH_B, mode: "default", onEvent: () => {} });
  // A's OWN thread's frame: if a's hook were still bound it would react — b's
  // rpc.attach() overwrote it, so only the LAST binder hears the process.
  shared.push(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: TH_A, delta: "x" } }));
  assert.equal(a.isTurnRunning, false, "chat A went deaf on its own frame — a shared server needs a demux, not a second client");
  shared.push(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: TH_B, delta: "x" } }));
  assert.equal(b.isTurnRunning, true, "the last binder owns the pipe");
});

await test("GAP: a frame with no threadId passes every chat's _mine filter", async () => {
  const { server, events } = makeChat({ threadId: TH_A });
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "anonymous" } }));
  assert.deepEqual(events.at(-1), ["delta", { text: "anonymous" }],
    "in shared mode this frame would reach EVERY chat — the demux must drop or attribute it");
});

await test("GAP: tokenUsage stats are not filtered by thread at all", async () => {
  const { server, events } = makeChat({ threadId: TH_A });
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: TH_B, tokenUsage: { last: { inputTokens: 5, outputTokens: 6 } } } }));
  assert.equal(events.some(([e, d]) => e === "stats" && d.inputTokens === 5), true,
    "chat B's counters would paint chat A — the shared server must route stats by threadId");
});

await test("GAP: an approval for another thread still opens a gate here", async () => {
  const { server, events } = makeChat({ threadId: TH_A });
  await server.start();
  server.rpc._receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "execCommandApproval", params: { threadId: TH_B, command: "ls" } }));
  assert.equal(events.some(([e]) => e === "permission_request"), true,
    "the gate ignores _mine — sharing must route approvals (and verify real codex even sends threadId on them)");
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\nAll ${pass} passed`);
process.exitCode = fail ? 1 : 0;
