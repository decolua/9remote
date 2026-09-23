// Gates over the v2 serve bus: permission.v2.asked / question.v2.asked become the
// pane's permission_request (question card shape for questions), replies go back
// through the v2 reply routes, and echoes settle the gate.
// Run: node agent/test/opencodeGates.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import * as server from "../features/ai/opencodeServer.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

function makeAdapter() {
  const calls = { replies: [], qReplies: [], qRejects: [] };
  const server = {
    listCommands: async () => [],
    runCommand: async () => ({}),
    createSession: async () => ({ id: "ses_t" }),
    prompt: async () => {},
    setSessionModel: async () => {},
    setSessionAgent: async () => {},
    interruptSession: async () => {},
    activeSessions: async () => ({}),
    subscribeBus: () => ({ close() {} }),
    replyPermission: async (sessionId, requestId, reply, message) => { calls.replies.push({ sessionId, requestId, reply, message }); },
    replyQuestion: async (requestId, answers, directory) => { calls.qReplies.push({ requestId, answers, directory }); },
    rejectQuestion: async (requestId, directory) => { calls.qRejects.push({ requestId, directory }); },
  };
  const events = [];
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]), server });
  adapter.activeSessionId = "ses_t";
  return { adapter, events, calls, of: (name) => events.filter(([e]) => e === name) };
}

const env = (type, data) => ({ type, data: { sessionID: "ses_t", ...data } });

console.log("Running opencode gate tests...");

await test("permission.v2.asked opens a permission gate with action+resources", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent(env("permission.v2.asked", {
    id: "per_1", action: "bash", resources: ["rm -rf /tmp/x"], metadata: { command: "rm -rf /tmp/x" }
  }));
  const [req] = of("permission_request");
  assert.ok(req, "no permission_request emitted");
  assert.equal(req[1].requestId, "per_1");
  assert.equal(req[1].tool, "bash");
  assert.deepEqual(req[1].input.resources, ["rm -rf /tmp/x"]);
  assert.equal(req[1].input.command, "rm -rf /tmp/x");
  assert.equal(adapter.pendingRequests.get("per_1").toolName, "bash");
  assert.equal(adapter.isTurnRunning, true, "a gate is only held mid-turn");
});

await test("mode auto answers every ask itself — the TUI's --dangerously-skip-permissions", async () => {
  const { adapter, events, calls } = makeAdapter();
  adapter.setOptions({ mode: "auto" });
  events.length = 0;
  adapter.handleEvent(env("permission.v2.asked", { id: "per_y", action: "read", resources: ["/app/.env"] }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.replies, [{ sessionId: "ses_t", requestId: "per_y", reply: "once", message: undefined }]);
  assert.equal(events.filter(([e]) => e === "permission_request").length, 0, "no card may interrupt the turn");
  assert.equal(adapter.pendingRequests.size, 0);
});

await test("mode auto never answers AskUserQuestion — that is the model asking the user", async () => {
  const { adapter, events, calls } = makeAdapter();
  adapter.setOptions({ mode: "auto" });
  events.length = 0;
  adapter.handleEvent(env("question.v2.asked", {
    id: "qst_1",
    questions: [{ question: "Ship to prod?", options: [{ label: "yes" }, { label: "no" }] }]
  }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.replies, [], "the question route must never be auto-answered");
  const [req] = events.filter(([e]) => e === "permission_request");
  assert.ok(req, "the question card must still reach the pane");
  assert.equal(req[1].tool, "AskUserQuestion");
});

await test("resolvePermission maps allow→once, allowAlways→always, deny→reject", async () => {
  const { adapter, calls } = makeAdapter();
  adapter.handleEvent(env("permission.v2.asked", { id: "per_1", action: "bash", resources: ["ls"] }));
  assert.equal(adapter.resolvePermission("per_1", "allow"), true);
  assert.equal(adapter.resolvePermission("per_2", "allow"), false, "unknown id refuses");
  adapter.handleEvent(env("permission.v2.asked", { id: "per_3", action: "edit", resources: ["a.ts"] }));
  adapter.resolvePermission("per_3", "allowAlways");
  adapter.handleEvent(env("permission.v2.asked", { id: "per_4", action: "edit", resources: ["b.ts"] }));
  adapter.resolvePermission("per_4", "deny", "not allowed");
  assert.deepEqual(calls.replies.map((r) => r.reply), ["once", "always", "reject"]);
  assert.equal(calls.replies[2].message, "not allowed");
  assert.equal(adapter.pendingRequests.size, 0, "answered gates must leave the map");
});

await test("permission.v2.replied settles the gate for every watcher", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent(env("permission.v2.asked", { id: "per_9", action: "bash", resources: ["ls"] }));
  adapter.handleEvent(env("permission.v2.replied", { requestID: "per_9", reply: "once" }));
  assert.equal(of("permission_resolved").length, 1);
  assert.equal(adapter.pendingRequests.size, 0);
});

await test("question.v2.asked becomes the AskUserQuestion card shape", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", {
    id: "que_1",
    questions: [{ question: "Deploy where?", header: "Target", options: [{ label: "prod", description: "live" }, { label: "staging", description: "" }], multiple: true, custom: true }]
  }));
  const [req] = of("permission_request");
  assert.equal(req[1].tool, "AskUserQuestion");
  const q = req[1].input.questions[0];
  assert.equal(q.question, "Deploy where?");
  assert.equal(q.header, "Target");
  assert.deepEqual(q.options, [{ label: "prod", description: "live" }, { label: "staging", description: "" }]);
  assert.equal(q.multiSelect, true);
  assert.equal(q.isOther, true);
});

await test("custom:false hides the free-text box", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", {
    id: "que_2",
    questions: [{ question: "Proceed?", header: "Go", options: [{ label: "yes", description: "" }], custom: false }]
  }));
  assert.equal(of("permission_request")[0][1].input.questions[0].isOther, undefined);
});

await test("resolveQuestion maps card answers to ordered string[][] labels", async () => {
  const { adapter, calls } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", {
    id: "que_3",
    questions: [
      { question: "Which DB?", header: "DB", options: [{ label: "D1", description: "" }, { label: "R2", description: "" }], multiple: true },
      { question: "Sure?", header: "Confirm", options: [{ label: "yes", description: "" }] }
    ]
  }));
  assert.equal(adapter.resolveQuestion("que_3", { "Which DB?": ["D1", "R2"], "Sure?": "yes" }), true);
  assert.deepEqual(calls.qReplies[0].answers, [["D1", "R2"], ["yes"]]);
  assert.equal(calls.qReplies[0].directory, "/tmp", "the reply must scope the v1 question store by the session cwd");
  assert.equal(adapter.pendingRequests.size, 0);
});

await test("resolveQuestion with no answers rejects the request", async () => {
  const { adapter, calls } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", { id: "que_4", questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "" }] }] }));
  adapter.resolveQuestion("que_4", {});
  assert.equal(calls.qRejects.length, 1);
  assert.equal(calls.qReplies.length, 0);
});

await test("skipping a question rejects it on the question store, not the permission route", async () => {
  const { adapter, calls } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", { id: "que_6", questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "" }] }] }));
  assert.equal(adapter.resolvePermission("que_6", "deny"), true);
  assert.equal(calls.qRejects.length, 1, "the skip must reach rejectQuestion");
  assert.equal(calls.replies.length, 0, "the permission route must not see a question id");
});

await test("question.v2.replied/rejected settle the gate", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent(env("question.v2.asked", { id: "que_5", questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "" }] }] }));
  adapter.handleEvent(env("question.v2.rejected", { requestID: "que_5" }));
  assert.equal(of("permission_resolved").filter(([e, d]) => d.requestId === "que_5").length, 1);
});

// e2e: route shapes against the real shared server (spawn/adopt 41998 like the app).
await test("e2e: live serve permission/question routes answer the v2 contract", async () => {
  // A fresh dir per run: a session directory that does not exist (or one the
  // long-lived server first saw while missing) 500s the permission route.
  const dir = mkdtempSync("/tmp/oc-gates-e2e-");
  const s = await server.createSession(dir);
  try {
    const asked = await server.requestPermission(s.id, { action: "bash", resources: ["ls /tmp"] });
    assert.ok(asked?.id?.startsWith("per_"), `expected a request id, got ${JSON.stringify(asked)}`);
    assert.ok(["allow", "deny", "ask"].includes(asked.effect), `unexpected effect ${asked.effect}`);
    const pending = await server.pendingPermissions(s.id);
    assert.ok(Array.isArray(pending));
    if (asked.effect === "ask" && pending.length) {
      await server.replyPermission(s.id, asked.id, "once");
      const after = await server.pendingPermissions(s.id);
      assert.equal(after.filter((p) => p.id === asked.id).length, 0, "reply must clear the pending ask");
    } else {
      console.log("    (no ask on this machine's config — round-trip skipped)");
    }
    await assert.rejects(() => server.replyPermission(s.id, "per_bogus", "once"), /not found|404|PermissionNotFound/i);
    const qPending = await server.listPendingQuestions(dir);
    assert.ok(Array.isArray(qPending));
    assert.ok(qPending.every((q) => q.id && q.sessionID), "entries must carry id and sessionID");
    await assert.rejects(() => server.replyQuestion("que_bogus", [["x"]], dir), /not found|404|QuestionNotFound/i);
  } finally {
    await server.deleteSession(s.id).catch(() => {});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
