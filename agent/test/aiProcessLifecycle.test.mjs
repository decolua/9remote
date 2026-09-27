// Which engine processes live past idle, and who cleans them up.
//
// Run: node agent/test/aiProcessLifecycle.test.mjs
//
// Documents the current split: claude (and the other conversation CLIs) hold ONE
// process per chat that idles between turns — RAM, by design. opencode instead
// shares one server per agent and retires it after the last session leaves; the
// orphan sweep retires daemon procs whose chat no longer exists.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";
import * as opencodeServer from "../features/ai/opencodeServer.js";
import { AiSession } from "../features/ai/aiSession.js";
import { AI_IDLE_KILL_MS } from "../features/ai/constants.js";
import { globalAiManager, sweepOrphanProcs } from "../features/ai/aiManager.js";
import { PATHS } from "../lib/constants.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};
const soon = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await test("claude keeps its process across turns (idle-held, not per-turn)", async () => {
  const calls = { start: 0, stop: 0 };
  const proc = {
    lineNo: 0, epoch: 1,
    async start(opts) { calls.start++; assert.equal(opts.keepStdin, true, "stdin must stay open for later turns"); return { lines: [], after: [], missed: 0, release: () => {} }; },
    async attach() { return { alive: true, lines: [], after: [], missed: 0, release: () => {} }; },
    stop() { calls.stop++; },
    write: () => true, signal: () => true
  };
  const adapter = new ClaudeAdapter({ cwd: process.cwd(), onEvent: () => {}, proc });
  await adapter.start("default");
  // The turn ends (a result record was seen via adopt) and nothing stops the CLI —
  // the next prompt rides the same process.
  await adapter.adopt(0, 1);
  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 0, "an idle claude chat must not lose its process");
});

await test("opencode retires the server after the last session leaves", async () => {
  const killed = [];
  opencodeServer._useTestProc({ fake: { exitCode: null, kill: (sig) => killed.push(sig) }, idleMs: 30 });
  opencodeServer.retainForSession();
  opencodeServer.retainForSession();
  opencodeServer.releaseForSession();
  await soon(60);
  assert.deepEqual(killed, [], "still one session left — server must live");
  opencodeServer.releaseForSession();
  await soon(80);
  assert.deepEqual(killed, ["SIGTERM"], "last session out retires the server");
  opencodeServer._useTestProc({});
});

await test("opencode retires an adopted leftover nobody uses", async () => {
  // An orphan from a dead agent is adopted (marker match) with no chat open; adoption
  // arms the same armIdleStop exercised here — the adopted pid must be retired, not
  // wait for a session that never comes.
  const realKill = process.kill;
  const killed = [];
  process.kill = (pid, sig) => { killed.push([pid, sig]); return true; };
  try {
    opencodeServer._useTestProc({ adoptedPid: 4242, idleMs: 30 });
    opencodeServer.releaseForSession();
    await soon(80);
    assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  } finally {
    process.kill = realKill;
    opencodeServer._useTestProc({});
  }
});

await test("sweep stops daemon procs whose chat is gone, keeps owned ones", async () => {
  // Owner via the live map, via a snapshot file, and no owner at all.
  const fileChat = "sweeptest-filechat";
  const file = path.join(PATHS.AI_SESSIONS, `claude-${fileChat}.json`);
  fs.writeFileSync(file, "{}");
  globalAiManager.sessions.set("sweeptest-livechat", {});
  const stopped = [];
  const client = {
    isConnected: () => true,
    procList: async () => ({ procs: [
      { procId: "sweeptest-gonechat", alive: true, total: 10 },
      { procId: "sweeptest-livechat", alive: true, total: 0 },
      { procId: fileChat, alive: true, total: 0 }
    ] }),
    procStop: async (id) => { stopped.push(id); return { success: true }; }
  };
  try {
    await sweepOrphanProcs(client);
    assert.deepEqual(stopped, ["sweeptest-gonechat"]);
  } finally {
    fs.unlinkSync(file);
    globalAiManager.sessions.delete("sweeptest-livechat");
  }
});

await test("sweep re-checks ownership before killing a proc created mid-sweep", async () => {
  // The chat is created (registered) between procList and procStop — the kill must stand down.
  const stopped = [];
  const client = {
    isConnected: () => true,
    procList: async () => {
      globalAiManager.sessions.set("sweeptest-racechat", {});
      return { procs: [{ procId: "sweeptest-racechat", alive: true, total: 0 }] };
    },
    procStop: async (id) => { stopped.push(id); return { success: true }; }
  };
  try {
    await sweepOrphanProcs(client);
    assert.deepEqual(stopped, [], "a chat registered mid-sweep owns its proc");
  } finally {
    globalAiManager.sessions.delete("sweeptest-racechat");
  }
});

// ── idle-kill ─────────────────────────────────────────────────────────────────

/** A resting chat: adapter present, no gate, nothing queued, long past the idle window. */
const restingSession = (id) => {
  const events = [];
  const s = new AiSession({ id, engine: "claude", cwd: process.cwd(), options: { mock: true }, onEvent: (sid, e) => events.push(e) });
  s.adapter = { pendingRequests: new Map(), stop: async () => {} };
  s.lastActivityAt = Date.now() - AI_IDLE_KILL_MS - 1000;
  return { s, events };
};

await test("idle-kill needs every gate open", async () => {
  const { s } = restingSession("idle-gates");
  try {
    assert.equal(s.idleKillEligible, true, "a resting chat is eligible");

    s.isTurnRunning = true;
    assert.equal(s.idleKillEligible, false, "running vetoes");
    s.isTurnRunning = false;

    s.adapter.pendingRequests.set(1, { toolName: "Bash", input: {} });
    assert.equal(s.idleKillEligible, false, "an open gate vetoes");
    s.adapter.pendingRequests.clear();

    s.promptQueue.push({ id: "q1" });
    assert.equal(s.idleKillEligible, false, "a queued prompt vetoes");
    s.promptQueue.length = 0;

    s.history.push({ seq: 1, event: "tool_result", data: { id: "bg1", async: true, status: "running" } });
    assert.equal(s.idleKillEligible, false, "a live async row vetoes");
    s.history.push({ seq: 2, event: "tool_result", data: { id: "bg1", async: true, status: "done" } });
    assert.equal(s.idleKillEligible, true, "a settled async row does not");
  } finally {
    // destroy() unlinks the snapshot — a leftover file would surface as a phantom chat.
    s.destroy();
  }
});

await test("idle-kill emits sleep, stops the CLI, and refuses to repeat", async () => {
  const { s, events } = restingSession("idle-kill-flow");
  try {
    let stopped = 0;
    s.adapter.stop = async () => { stopped++; };
    const killed = await s.idleKill();
    assert.equal(killed, true);
    assert.equal(s.asleep, true);
    assert.equal(stopped, 1);
    assert.ok(events.includes("sleep"), "the sleep event is recorded for every surface");
    assert.equal(await s.idleKill(), false, "an already-sleeping chat has nothing to kill");
    assert.equal(stopped, 1);
  } finally {
    s.destroy();
  }
});

await test("a prompt wakes a sleeping chat", async () => {
  const { s } = restingSession("idle-wake");
  try {
    await s.idleKill();
    s.emitNormalized("user_message", { message: "again" });
    assert.equal(s.asleep, false);
    assert.equal(s.idleKillEligible, false, "fresh activity restarts the idle window");
  } finally {
    s.destroy();
  }
});

await test("engines outside the idle-kill set never qualify", async () => {
  const { s } = restingSession("idle-opencode");
  try {
    s.engine = "opencode";
    assert.equal(s.idleKillEligible, false);
    assert.equal(await s.idleKill(), false);
  } finally {
    s.destroy();
  }
});

await test("a codex pane qualifies too, and its lost server self-heals on prompt", async () => {
  const { s } = restingSession("idle-codex");
  try {
    s.engine = "codex";
    assert.equal(s.idleKillEligible, true);
  } finally {
    s.destroy();
  }
  // After idle-kill the app-server is gone; sendPrompt must HOLD the prompt and
  // kick the respawn (restart() drains the held prompts once the thread is back).
  const { CodexAdapter } = await import("../features/ai/adapters/codexAdapter.js");
  const a = new CodexAdapter({ cwd: process.cwd(), onEvent: () => {} });
  assert.equal(a.persistent, true);
  let restarts = 0;
  a.restart = async () => { restarts++; };
  a.sendPrompt("hello again", []);
  assert.equal(a._heldPrompts.length, 1, "the prompt waits, never drops");
  assert.equal(restarts, 1, "the respawn is kicked, not waited on");
});

await test("sleep survives the status pipeline — not demoted to idle on the wire", async () => {
  const { applyEvent } = await import("../features/terminal/statusManager.js");
  const entry = applyEvent({ type: "sleep", sessionId: "idle-sleep-state" });
  assert.equal(entry?.state, "sleep", "broadcastAiStatus feeds chat states through applyEvent; a miss maps to idle and the dot lies");
});

await test("a failed codex respawn holds prompts without spinning a loop", async () => {
  const { CodexAdapter } = await import("../features/ai/adapters/codexAdapter.js");
  const errors = [];
  const a = new CodexAdapter({ cwd: process.cwd(), onEvent: (e, d) => { if (e === "error") errors.push(d.message); } });
  a.start = async () => { throw new Error("spawn failed"); };
  a._heldPrompts.push({ prompt: "p1", attachments: null });
  await a.restart();
  // With the drain-loop bug this test hangs: every drained prompt re-kicks restart.
  assert.equal(a._heldPrompts.length, 1, "held for the next user prompt — not dropped, not drained");
  assert.equal(errors.length, 1, "the pane hears why it went quiet");
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\nAll ${pass} passed`);
process.exitCode = fail ? 1 : 0;
