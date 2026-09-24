import assert from "node:assert/strict";
import { hostTree, hostSummary, relTime, orderedHostsOf, scopedFleetLists, scopedWsId, rawWsIdOf, activeWsForHost, scopeOf } from "../features/hosts/lib/fleetTree.js";

const ws = [
  { id: "w1", name: "9remote", path: "/w/9remote" },
  { id: "w2", name: "api", path: "/w/api" }
];
const ss = [
  { id: "a", workspaceId: "w1" },
  { id: "b", workspaceId: "w2" },
  { id: "c", workspaceId: null },
  { id: "d", workspaceId: "gone" } // dangling workspace id falls into ungrouped
];

const tree = hostTree(ss, ws);
assert.deepEqual(tree.map((g) => (g.workspace ? g.workspace.id : null)), ["w1", "w2", null]);
assert.deepEqual(tree[0].sessions.map((s) => s.id), ["a"]);
assert.deepEqual(tree[2].sessions.map((s) => s.id), ["c", "d"]);
assert.equal(hostTree([], []).length, 0);
assert.equal(hostTree([{ id: "x" }], []).length, 1);
// A workspace with no sessions still shows (its empty row is the create-terminal door)
const emptyTree = hostTree([], [{ id: "w9", name: "fresh" }]);
assert.equal(emptyTree.length, 1);
assert.deepEqual(emptyTree[0].sessions, []);

const sum = hostSummary(ss, { a: { state: "working" }, b: { state: "blocked" }, c: { state: "done" } });
assert.deepEqual(sum, { sessions: 4, working: 1, attention: 2 });
assert.deepEqual(hostSummary([], {}), { sessions: 0, working: 0, attention: 0 });

// fake t(): returns the key, interpolating {n} so relative-time buckets are visible
const t = (k, p) => (p && p.n !== undefined ? `${k}:${p.n}` : k);

// relTime buckets
assert.equal(relTime(Date.now() - 10 * 1000, t), "login.justNow");
assert.equal(relTime(Date.now() - 5 * 60000, t), "login.minutesAgo:5");
assert.equal(relTime(Date.now() - 3 * 3600000, t), "login.hoursAgo:3");
assert.equal(relTime(Date.now() - 3 * 86400000, t), "login.daysAgo:3");
assert.match(relTime(Date.now() - 30 * 86400000, t), /20\d\d/); // beyond a week → locale date
assert.equal(relTime(null, t), "");
assert.equal(relTime(0, t), "");

// orderedHostsOf: every host in add order — the current host keeps its spot (no
// login-based sorting), a synthetic "main" keeps the tree visible pre-settle
const mk = (key, label, status) => ({ key, label, status });
const all = [mk("off", "Zeta", "offline"), mk("cur", "Current", "full"), mk("b", "Bravo", "online"), mk("a", "Alpha", "online"), mk("off2", "Alpha", "offline")];
assert.deepEqual(orderedHostsOf(all, "cur").map((h) => h.key), ["off", "cur", "b", "a", "off2"]);
// fleet not settled yet → the main entry still renders, ahead of whatever is known
assert.deepEqual(orderedHostsOf([mk("b", "Bravo", "online")], null).map((h) => h.key), ["main", "b"]);
assert.deepEqual(orderedHostsOf([], "cur").map((h) => h.key), ["main"]);

// workspace-id scoping round trip
assert.equal(scopedWsId("h2", "w1"), "h2:w1");
// cache scopes: main keeps the legacy (empty) key, a fleet head namespaces its own
assert.equal(scopeOf(null), "");
assert.equal(scopeOf("h2"), "@h2");
assert.equal(rawWsIdOf("h2:w1", "h2"), "w1");
assert.equal(rawWsIdOf("main:w1", "h2"), null);
assert.equal(activeWsForHost("h2:w1", "h2"), "w1");
assert.equal(activeWsForHost("h2:_", "h2"), null); // synthetic ungrouped → raw null
assert.equal(activeWsForHost("main:w1", "h2"), undefined); // another host's workspace
assert.equal(activeWsForHost(null, "h2"), undefined);

// scopedFleetLists: other hosts' sessions/workspaces re-keyed under "head:" so they
// flow through the existing workspace model (ids never collide with the main host's).
const fleetHosts = [
  { key: "main", status: "full", sessions: [{ id: "m1" }], workspaces: [{ id: "w1", name: "own" }] },
  {
    key: "h2", label: "KEY-2", status: "online",
    sessions: [{ id: "s1", workspaceId: "w1" }, { id: "s2", workspaceId: null }, { id: "s3", workspaceId: "w1" }],
    workspaces: [{ id: "w1", name: "9remote", path: "/x" }]
  }
];
const scoped = scopedFleetLists(fleetHosts, "main");
assert.deepEqual(scoped.workspaces.map((w) => w.id), ["h2:w1", "h2:_"]); // ungrouped becomes a named group
assert.equal(scoped.workspaces[0].name, "9remote");
assert.deepEqual(scoped.sessions.map((s) => s.workspaceId), ["h2:w1", "h2:_", "h2:w1"]);
assert.equal(scoped.sessions[0].hostKey, "h2");
// Main host and unsynced fleets contribute nothing.
assert.deepEqual(scopedFleetLists(fleetHosts, null), { sessions: [], workspaces: [] });
assert.deepEqual(scopedFleetLists([fleetHosts[0]], "main"), { sessions: [], workspaces: [] });
// Originals untouched (no in-place mutation of fleet state).
assert.equal(fleetHosts[1].sessions[1].workspaceId, null);

console.log("fleetTree ok");
