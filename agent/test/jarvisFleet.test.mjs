// The fleet snapshot — how Jarvis sees every open session without reading a single
// raw terminal byte. PTY facts come from the daemon, AI state overlays on top, and
// the branch map rides in from a git probe the caller owns.
//
// Run: node agent/test/jarvisFleet.test.mjs
import assert from "node:assert/strict";
import { buildFleetSnapshot } from "../features/jarvis/fleetSnapshot.js";

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const run = async () => {
  for (const { name, fn } of cases) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

console.log("Running jarvis fleet snapshot tests...");

const pty = (id, over = {}) => ({
  id, name: `Term ${id}`, cwd: `/proj/${id}`, workspacePath: null,
  foregroundProcess: "zsh", ...over
});

const ai = (id, over = {}) => ({
  id, engine: "claude", cwd: `/proj/${id}`, isTurnRunning: false,
  activePermission: null, lastPrompt: "", ...over
});

test("a plain PTY session is an idle bash row with its cwd", () => {
  const rows = buildFleetSnapshot({ ptySessions: [pty("s1")], aiSessions: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "s1");
  assert.equal(rows[0].engine, "bash");
  assert.equal(rows[0].status, "idle");
  assert.equal(rows[0].cwd, "/proj/s1");
});

test("a foreground CLI names the engine when no AI session covers it", () => {
  const rows = buildFleetSnapshot({ ptySessions: [pty("s1", { foregroundProcess: "claude" })], aiSessions: [] });
  assert.equal(rows[0].engine, "claude");
});

test("an AI session overlays the matching PTY row", () => {
  const rows = buildFleetSnapshot({
    ptySessions: [pty("s1", { foregroundProcess: "claude" })],
    aiSessions: [ai("s1", { isTurnRunning: true, lastPrompt: "viết API" })]
  });
  assert.equal(rows[0].engine, "claude");
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].lastPrompt, "viết API");
});

test("a waiting gate outranks a running turn — needs_input wins", () => {
  const rows = buildFleetSnapshot({
    ptySessions: [pty("s1")],
    aiSessions: [ai("s1", { isTurnRunning: true, activePermission: { tool: "Bash" } })]
  });
  assert.equal(rows[0].status, "needs_input");
  assert.ok(rows[0].question, "the gate's ask is surfaced for Jarvis to read aloud");
});

test("an idle AI session reads idle", () => {
  const rows = buildFleetSnapshot({ ptySessions: [pty("s1")], aiSessions: [ai("s1")] });
  assert.equal(rows[0].status, "idle");
});

test("the branch map decorates rows that have one", () => {
  const rows = buildFleetSnapshot({
    ptySessions: [pty("s1"), pty("s2")],
    aiSessions: [],
    branches: { s2: "feat/login" }
  });
  assert.equal(rows[0].branch, null);
  assert.equal(rows[1].branch, "feat/login");
});

test("worktree flag rides in with the branch probe", () => {
  const rows = buildFleetSnapshot({
    ptySessions: [pty("s1", { cwd: "/proj/.worktrees/x" })],
    aiSessions: [],
    branches: { s1: "feat/x" },
    worktrees: { s1: true }
  });
  assert.equal(rows[0].isWorktree, true);
});

test("an AI session with no PTY row still appears — a headless chat pane", () => {
  const rows = buildFleetSnapshot({ ptySessions: [], aiSessions: [ai("s9", { isTurnRunning: true })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "s9");
  assert.equal(rows[0].status, "running");
});

await run();
