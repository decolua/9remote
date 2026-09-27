// Closing a terminal has to end everything that pointed at it. The agent history
// panel offers to focus the terminal already running a conversation, so a row
// left holding a closed terminal's id sends the user to a pane with nothing
// behind it — the failure this guards.
//
// Run: node --import ./test/loader-alias.mjs web/test/closeSession.test.mjs
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// The store reaches for localStorage on import; give it somewhere harmless to go.
globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {}
};

const { useTerminalStore } = await import("../shared/stores/terminalStore.js");
const store = () => useTerminalStore.getState();

function seedOpenTerminal(id, cwd = "/w") {
  store().addOpenedSession(id);
  store().touchLivePane([id]);
  store().setSessionAgent(id, "claude");
  store().setAgentHistory(cwd, [{ agent: "claude", sessionId: "conv-1", openSessionId: id }]);
}

test("closing a terminal drops the pane that was rendering it", () => {
  seedOpenTerminal("dead");
  store().closeSession("dead");
  assert.ok(!store().openedSessions.includes("dead"));
  assert.ok(!store().livePanes.includes("dead"));
});

test("closing a terminal forgets which agent CLI it was running", () => {
  seedOpenTerminal("dead2");
  store().closeSession("dead2");
  assert.equal(store().agentBySession.dead2, undefined);
});

test("closing a terminal invalidates history, which named it as live", () => {
  seedOpenTerminal("dead3");
  assert.ok(store().agentHistory["/w"], "seeded");
  store().closeSession("dead3");
  // Invalidated, not discarded: the panel keeps rendering while the next poll
  // re-asks the host which terminals are live.
  assert.equal(store().agentHistory["/w"].at, 0);
  assert.equal(store().agentHistory["/w"].sessions.length, 1);
});

test("closing one terminal leaves the others alone", () => {
  seedOpenTerminal("keep");
  seedOpenTerminal("drop");
  store().closeSession("drop");
  assert.ok(store().openedSessions.includes("keep"));
  assert.equal(store().agentBySession.keep, "claude");
});

test("closing a terminal that was never open is not an error", () => {
  const before = store().openedSessions.length;
  store().closeSession("never-existed");
  assert.equal(store().openedSessions.length, before);
});



test("closing a terminal does not blank the history of directories it never ran in", () => {
  // Invalidation must not read as "there is nothing here". The panel renders
  // whatever the store holds, so dropping a cwd's rows outright empties the
  // panel until the next poll — up to a full TTL of blank.
  store().setAgentHistory("/other", [{ agent: "codex", sessionId: "c-1", openSessionId: null }]);
  seedOpenTerminal("dead4", "/w");
  store().closeSession("dead4");
  assert.ok(store().agentHistory["/other"], "an unrelated directory keeps its rows");
});

test("a closed terminal stops being named as live, without the rows disappearing", () => {
  seedOpenTerminal("dead5", "/w");
  store().closeSession("dead5");
  const entry = store().agentHistory["/w"];
  assert.ok(entry, "the rows are still there to render");
  assert.equal(entry.sessions[0].openSessionId, null, "but no longer point at a dead terminal");
});

test("invalidated rows are stale enough that the next poll refetches them", () => {
  seedOpenTerminal("dead6", "/w");
  store().closeSession("dead6");
  const { at } = store().agentHistory["/w"];
  assert.ok(Date.now() - at >= 30000, "the TTL gate sees them as expired");
});

test("resuming a row refreshes history, so the new terminal shows as its owner", () => {
  // The claim happens on the host; the panel only learns about it by asking
  // again. Without invalidating, the row it was just resumed from stays grey
  // until the poll — the terminal is linked but nothing on screen says so.
  store().setAgentHistory("/w", [{ agent: "claude", sessionId: "conv-1", openSessionId: null }]);
  store().invalidateAgentHistory();
  assert.equal(store().agentHistory["/w"].at, 0, "the next poll refetches");
  assert.equal(store().agentHistory["/w"].sessions.length, 1, "and renders meanwhile");
});

test("invalidating with no history held is not an error", () => {
  store().clearOpenedSessions();
  useTerminalStore.setState({ agentHistory: {} });
  store().invalidateAgentHistory();
  assert.deepEqual(store().agentHistory, {});
});

// Swapping a chat pane's session must keep the pane count and its slot: the pane row
// re-measures its widths (and re-centers) whenever the count changes, which is what
// made "+" flash and scroll.
test("replacing a session swaps it in place, keeping the row's slot", () => {
  store().clearOpenedSessions();
  store().addOpenedSession("a");
  store().addOpenedSession("old");
  store().addOpenedSession("b");
  store().touchLivePane(["a", "old", "b"]);
  store().replaceOpenedSession("old", "new");
  assert.deepEqual(store().openedSessions, ["a", "new", "b"]);
  assert.deepEqual(store().livePanes, ["a", "new", "b"]);
});

test("a replacement whose slot already closed still opens its pane", () => {
  store().clearOpenedSessions();
  store().addOpenedSession("a");
  store().touchLivePane(["a"]);
  store().replaceOpenedSession("old", "new");
  assert.deepEqual(store().openedSessions, ["a", "new"]);
});

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
