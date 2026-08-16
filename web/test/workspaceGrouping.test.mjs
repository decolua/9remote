// Sidebar grouping. The rule this file exists to protect: a terminal belongs to the
// workspace it was created in, not to whatever directory the user has cd'd into.
// Run: node --import ./test/loader-alias.mjs test/workspaceGrouping.test.mjs
import assert from "node:assert/strict";
import {
  groupSessionsByWorkspace, shortenHomePath, workspaceGitPath
} from "../features/terminal/lib/workspaceGrouping.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const WS = [
  { id: "w1", name: "9remote", path: "/Users/me/9remote" },
  { id: "w2", name: "dotfiles", path: "/Users/me/.config" }
];

test("sessions bucket into their workspace, in workspace order", () => {
  const g = groupSessionsByWorkspace(
    [{ id: "b", workspaceId: "w2" }, { id: "a", workspaceId: "w1" }],
    WS
  );
  assert.deepEqual(g.map((x) => x.id), ["w1", "w2"]);
  assert.deepEqual(g[0].items.map((s) => s.id), ["a"]);
  assert.deepEqual(g[1].items.map((s) => s.id), ["b"]);
});

test("a cd does NOT move a terminal to another workspace", () => {
  const g = groupSessionsByWorkspace(
    [{ id: "a", workspaceId: "w1", workspacePath: "/Users/me/9remote", cwd: "/Users/me/.config" }],
    WS
  );
  assert.deepEqual(g[0].items.map((s) => s.id), ["a"], "still in w1 despite cwd pointing at w2");
  assert.deepEqual(g[1].items, []);
});

test("unassigned sessions land in a trailing bucket", () => {
  const g = groupSessionsByWorkspace([{ id: "u" }], WS, "Ungrouped");
  assert.equal(g.at(-1).id, null);
  assert.equal(g.at(-1).name, "Ungrouped");
  assert.deepEqual(g.at(-1).items.map((s) => s.id), ["u"]);
});

test("no unassigned session means no trailing bucket", () => {
  const g = groupSessionsByWorkspace([{ id: "a", workspaceId: "w1" }], WS);
  assert.equal(g.length, 2);
  assert.ok(g.every((x) => x.id !== null));
});

test("an empty workspace still shows, so its + button is reachable", () => {
  const g = groupSessionsByWorkspace([], WS);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].items, []);
});

test("a session whose workspace was deleted falls into unassigned", () => {
  const g = groupSessionsByWorkspace([{ id: "x", workspaceId: "gone" }], WS, "Ungrouped");
  const orphanBucket = g.find((b) => b.items.some((s) => s.id === "x"));
  assert.equal(orphanBucket, undefined, "an unknown workspace id creates no bucket");
});

test("legacy groupId-only sessions still group", () => {
  const g = groupSessionsByWorkspace([{ id: "a", groupId: "w1" }], WS);
  assert.deepEqual(g[0].items.map((s) => s.id), ["a"]);
});

test("shortenHomePath collapses the home prefix only on a segment boundary", () => {
  assert.equal(shortenHomePath("/Users/me/9remote", "/Users/me"), "~/9remote");
  assert.equal(shortenHomePath("/Users/me", "/Users/me"), "~");
  assert.equal(shortenHomePath("/Users/methodical/x", "/Users/me"), "/Users/methodical/x");
  assert.equal(shortenHomePath("/opt/src", "/Users/me"), "/opt/src");
  assert.equal(shortenHomePath("/opt/src", null), "/opt/src");
  assert.equal(shortenHomePath("", "/Users/me"), "");
});

test("workspaceGitPath prefers the workspace root", () => {
  assert.equal(workspaceGitPath({ path: "/a", items: [{ workspacePath: "/b" }] }), "/a");
});

test("a path-less workspace falls back to a session's fixed workspacePath", () => {
  assert.equal(workspaceGitPath({ path: null, items: [{}, { workspacePath: "/b" }] }), "/b");
  assert.equal(workspaceGitPath({ path: null, items: [{ cwd: "/c" }] }), null, "live cwd is not a root");
  assert.equal(workspaceGitPath(null), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
