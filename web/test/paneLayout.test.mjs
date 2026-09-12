// Characterization tests for the pane mount/render rules. These encode the behaviour that
// existed when panes were grouped by groupId, so the group -> workspace rename cannot
// silently change which panes stay alive (a regression here shows up as a blank pane or a
// lost scrollback buffer).
// Run: node --import ./test/loader-alias.mjs test/paneLayout.test.mjs
import assert from "node:assert/strict";
import {
  derivePaneLayout, mountDelayFor, sessionWorkspaceId, autoFitPaneWidth, STAGGER_MS, UNGROUPED_KEY
} from "../features/terminal/lib/paneLayout.js";

// Defaults matching terminalConfig: PANE_WIDTH.min 400, PANE_GAP_PX 2, no row padding.
const fit = (over = {}) => autoFitPaneWidth({
  rowWidth: 1600, paneCount: 1, sidebarWidth: 190, sidePx: 0,
  gapPx: 2, paddingPx: 0, minWidth: 400, applied: null, ...over
});

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const s = (id, workspaceId) => ({ id, workspaceId });

test("legacy groupId is read when the agent sends no workspaceId", () => {
  assert.equal(sessionWorkspaceId({ id: "a", groupId: "g1" }), "g1");
  assert.equal(sessionWorkspaceId({ id: "a", workspaceId: "w1", groupId: "g1" }), "w1");
  assert.equal(sessionWorkspaceId({ id: "a" }), null);
});

test("active workspace sessions render and mount", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("b", "w1"), s("c", "w2")],
    openedSessions: ["a", "b", "c"],
    livePanes: [],
    mountedWorkspaces: {},
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.deepEqual([...r.workspaceSessionIds], ["a", "b"]);
  assert.deepEqual(r.workspaceOpenedSessions, ["a", "b"]);
  assert.ok(r.mountedSet.has("a") && r.mountedSet.has("b"));
  assert.ok(!r.mountedSet.has("c"), "unvisited workspace stays a placeholder");
});

test("renderedSessions keeps openedSessions order, not session order", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("b", "w1")],
    openedSessions: ["b", "a"],
    livePanes: [],
    mountedWorkspaces: {},
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.deepEqual(r.renderedSessions, ["b", "a"]);
});

test("LRU live panes from another workspace still render", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("c", "w2")],
    openedSessions: ["a", "c"],
    livePanes: ["c"],
    mountedWorkspaces: {},
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.deepEqual(r.renderedSessions, ["a", "c"]);
});

test("a live pane that was closed does not render", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("c", "w2")],
    openedSessions: ["a"],
    livePanes: ["c"],
    mountedWorkspaces: {},
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.deepEqual(r.renderedSessions, ["a"]);
});

test("desktop mounts panes of other VISITED workspaces", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("c", "w2")],
    openedSessions: ["a", "c"],
    livePanes: ["c"],
    mountedWorkspaces: { w2: true },
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.ok(r.mountedSet.has("c"));
});

test("mobile mounts ONLY the active workspace, even if visited", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("c", "w2")],
    openedSessions: ["a", "c"],
    livePanes: ["c"],
    mountedWorkspaces: { w2: true },
    activeWorkspaceId: "w1",
    isDesktop: false
  });
  assert.ok(r.mountedSet.has("a"));
  assert.ok(!r.mountedSet.has("c"));
});

test("ungrouped sessions key off UNGROUPED_KEY", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("u", null)],
    openedSessions: ["a", "u"],
    livePanes: ["u"],
    mountedWorkspaces: { [UNGROUPED_KEY]: true },
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.ok(r.mountedSet.has("u"));
});

test("null active workspace selects the ungrouped sessions", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("u", null)],
    openedSessions: ["a", "u"],
    livePanes: [],
    mountedWorkspaces: {},
    activeWorkspaceId: null,
    isDesktop: true
  });
  assert.deepEqual([...r.workspaceSessionIds], ["u"]);
});

test("undefined active workspace behaves like null", () => {
  const r = derivePaneLayout({
    sessions: [s("u", null)],
    openedSessions: ["u"],
    livePanes: [],
    mountedWorkspaces: {},
    activeWorkspaceId: undefined,
    isDesktop: true
  });
  assert.deepEqual([...r.workspaceSessionIds], ["u"]);
});

test("join order staggers non-focused panes, focus joins immediately", () => {
  const r = derivePaneLayout({
    sessions: [s("a", "w1"), s("b", "w1"), s("c", "w1")],
    openedSessions: ["a", "b", "c"],
    livePanes: [],
    mountedWorkspaces: {},
    activeWorkspaceId: "w1",
    isDesktop: true
  });
  assert.equal(mountDelayFor("a", true, r.workspaceIndex), 0);
  assert.equal(mountDelayFor("b", false, r.workspaceIndex), STAGGER_MS);
  assert.equal(mountDelayFor("c", false, r.workspaceIndex), 2 * STAGGER_MS);
  assert.equal(mountDelayFor("zz", false, r.workspaceIndex), 0, "unknown pane joins now");
});

// --- autoFitPaneWidth: side panels narrow the panes, never widen them ---

test("no measurement yet returns null (falls back to flex)", () => {
  assert.equal(fit({ rowWidth: 0 }), null);
  assert.equal(fit({ paneCount: 0 }), null);
});

test("panes split the row minus the sidebar and every open side panel", () => {
  assert.equal(fit({ paneCount: 2, sidePx: 0 }), Math.floor((1600 - 190 - 2) / 2));
  assert.equal(fit({ paneCount: 2, sidePx: 420 }), Math.floor((1600 - 190 - 420 - 2) / 2));
});

test("opening a side panel narrows an auto row", () => {
  const wide = fit({ paneCount: 1, sidePx: 0 });
  const narrow = fit({ paneCount: 1, sidePx: 420, applied: wide });
  assert.equal(narrow, wide - 420);
});

test("closing it back does NOT widen — the panes hold and the row takes up the slack", () => {
  const narrow = fit({ paneCount: 1, sidePx: 420 });
  assert.equal(fit({ paneCount: 1, sidePx: 0, applied: narrow }), narrow);
});

test("a deliberate fit (applied null) re-widens after the panel closes", () => {
  assert.equal(fit({ paneCount: 1, sidePx: 0, applied: null }), 1600 - 190);
});

test("narrowing keeps tracking while the panel is dragged open", () => {
  let w = fit({ paneCount: 1 });
  w = fit({ paneCount: 1, sidePx: 200, applied: w });
  w = fit({ paneCount: 1, sidePx: 260, applied: w });
  assert.equal(w, 1600 - 190 - 260);
});

test("sub-pixel noise from layout rounding is not a narrowing", () => {
  const w = fit({ paneCount: 3 });
  assert.equal(fit({ paneCount: 3, sidePx: 0.4, applied: w }), w);
});

test("a row clamped at the floor stays clamped when the panel closes", () => {
  const clamped = fit({ rowWidth: 900, paneCount: 1, sidePx: 600 }); // base < min → 400
  assert.equal(clamped, 400);
  assert.equal(fit({ rowWidth: 900, paneCount: 1, sidePx: 0, applied: clamped }), 400,
    "widening it back is the double-click's job, not the close");
  assert.equal(fit({ rowWidth: 900, paneCount: 1, sidePx: 0, applied: null }), 710);
});

test("panes at min hold the floor, the row scrolls instead", () => {
  assert.equal(fit({ rowWidth: 800, paneCount: 3 }), 400);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);