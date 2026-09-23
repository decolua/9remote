import assert from "node:assert/strict";
import { hostTree, hostSummary } from "../features/hosts/lib/fleetTree.js";

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

const sum = hostSummary(ss, { a: { state: "working" }, b: { state: "blocked" }, c: { state: "done" } });
assert.deepEqual(sum, { sessions: 4, working: 1, attention: 2 });
assert.deepEqual(hostSummary([], {}), { sessions: 0, working: 0, attention: 0 });

console.log("fleetTree ok");
