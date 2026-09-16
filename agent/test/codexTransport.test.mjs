// Which codex transport a chat ends up on, decided at ONE door.
//
// The app-server holds one process for the whole chat, so it needs the daemon — the
// process has to outlive an agent restart the way Claude's does. Without a daemon there
// is nothing to hold it, and the chat must fall back to `exec --json` (a process per
// turn) rather than open a connection nobody can adopt.
//
// Run: node agent/test/codexTransport.test.mjs
import assert from "node:assert/strict";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const fakeProc = () => ({ onLine: null, onExit: null, write() {}, async start() { return { lines: [], release() {}, commit() {} }; }, async attach() { return { lines: [], alive: false, release() {} }; }, async stop() {} });

test("nothing asked for means app-server: the transport that streams thinking", () => {
  // The default moved here once the app-server was proven end to end against the real
  // CLI. `exec` is still reachable by name — see the tests below — but a chat that says
  // nothing gets the one that behaves like the CLI's own TUI.
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  delete process.env.NREMOTE_CODEX_TRANSPORT;
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc() });
    assert.equal(a.transport, "app-server");
    assert.equal(a.persistent, true);
  } finally {
    if (before !== undefined) process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

test("the way back is asking for exec by name", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  delete process.env.NREMOTE_CODEX_TRANSPORT;
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc(), transport: "exec" });
    assert.equal(a.transport, "exec");
    assert.equal(a.persistent, false, "exec spawns per turn and has nothing to start");
  } finally {
    if (before !== undefined) process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

test("the session asking for it wins over the environment", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  process.env.NREMOTE_CODEX_TRANSPORT = "exec";
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc(), transport: "app-server" });
    assert.equal(a.transport, "app-server");
    assert.ok(a.persistent);
  } finally {
    if (before === undefined) delete process.env.NREMOTE_CODEX_TRANSPORT;
    else process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

test("the environment switches the deployment back to exec", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  process.env.NREMOTE_CODEX_TRANSPORT = "exec";
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc() });
    assert.equal(a.transport, "exec");
  } finally {
    if (before === undefined) delete process.env.NREMOTE_CODEX_TRANSPORT;
    else process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

// A typo must not be read as "exec": that would quietly downgrade a whole deployment to
// the older transport, and the symptom would look like codex misbehaving rather than a
// misspelt setting. Only the exact word is a choice.
test("a misspelt value keeps the default rather than downgrading silently", () => {
  const before = process.env.NREMOTE_CODEX_TRANSPORT;
  process.env.NREMOTE_CODEX_TRANSPORT = "execc";
  try {
    const a = new CodexAdapter({ cwd: "/w", onEvent: () => {}, proc: fakeProc() });
    assert.equal(a.transport, "app-server", "only the exact word picks the older path");
  } finally {
    if (before === undefined) delete process.env.NREMOTE_CODEX_TRANSPORT;
    else process.env.NREMOTE_CODEX_TRANSPORT = before;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
