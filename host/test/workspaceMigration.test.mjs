// group -> workspace migration. The rule that matters: no session may be dropped, and a
// session already carrying a group keeps it (the user's own grouping outranks the guessed
// git root).
// Run: node agent/test/workspaceMigration.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import {
  findGitRoot, migrateGroupsToWorkspaces, workspaceIdForPath, workspaceNameFromPath,
  commonAncestor, assignOrphanSessions
} from "../features/terminal/workspaceMigration.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Fake fs: a set of paths that "exist".
function fakeIo(existing) { return { existsSync: (p) => existing.has(p) }; }
const repo = path.resolve("/repo");
const io = fakeIo(new Set([path.join(repo, ".git")]));

test("findGitRoot walks up to the nearest .git", () => {
  assert.equal(findGitRoot(path.join(repo, "web", "features"), io), repo);
  assert.equal(findGitRoot(repo, io), repo);
});

test("findGitRoot returns null outside any repo and on bad input", () => {
  assert.equal(findGitRoot(path.resolve("/tmp/elsewhere"), io), null);
  assert.equal(findGitRoot(null, io), null);
  assert.equal(findGitRoot("", io), null);
  assert.equal(findGitRoot(123, io), null);
});

test("findGitRoot survives an fs that throws", () => {
  const throwing = { existsSync: () => { throw new Error("EACCES"); } };
  assert.equal(findGitRoot(repo, throwing), null);
});

test("a legacy group keeps its name but gains a real path from its terminals", () => {
  const r = migrateGroupsToWorkspaces(
    { groups: [{ id: "g1", name: "Work", createdAt: 10 }], sessionGroups: { s1: "g1" } },
    new Map([["s1", { cwd: path.join(repo, "web") }]]),
    io
  );
  const ws = r.workspaces.find((w) => w.id === "g1");
  assert.equal(ws.name, "Work", "the user's own name survives");
  assert.equal(ws.path, repo, "a path-less workspace would show an empty tree and no git");
  assert.equal(r.sessionWorkspaces.s1, "g1");
  assert.equal(r.sessionPaths.s1, repo, "and the session is pinned to that root");
});

test("a group spanning two sibling repos splits into one workspace per repo", () => {
  const other = path.resolve("/repo2");
  const io2 = fakeIo(new Set([path.join(repo, ".git"), path.join(other, ".git")]));
  const r = migrateGroupsToWorkspaces(
    { groups: [{ id: "g1", name: "Both" }], sessionGroups: { a: "g1", b: "g1" } },
    new Map([["a", { cwd: repo }], ["b", { cwd: other }]]),
    io2
  );
  // Their only shared ancestor is "/", which is too broad to be a workspace, so the group
  // cannot be honoured — each terminal follows its own repo instead of being lumped
  // together under the filesystem root.
  assert.deepEqual(r.workspaces.map((w) => w.path).sort(), [repo, other].sort());
  assert.notEqual(r.sessionWorkspaces.a, r.sessionWorkspaces.b);
});

test("a group whose terminals share a parent roots at that parent", () => {
  const a = path.resolve("/work/svc-a");
  const b = path.resolve("/work/svc-b");
  const io2 = fakeIo(new Set());
  const r = migrateGroupsToWorkspaces(
    { groups: [{ id: "g1", name: "Services" }], sessionGroups: { a: "g1", b: "g1" } },
    new Map([["a", { cwd: a }], ["b", { cwd: b }]]),
    io2
  );
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.workspaces[0].path, path.resolve("/work"));
  assert.equal(r.workspaces[0].name, "Services");
});

test("a group with no surviving terminals is dropped, not kept path-less", () => {
  const r = migrateGroupsToWorkspaces(
    { groups: [{ id: "dead", name: "Old" }], sessionGroups: {} },
    new Map(),
    io
  );
  assert.deepEqual(r.workspaces, []);
});

test("ungrouped session attaches to the workspace of its git root", () => {
  const r = migrateGroupsToWorkspaces(
    {},
    new Map([["s1", { cwd: path.join(repo, "web") }]]),
    io
  );
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.workspaces[0].path, repo);
  assert.equal(r.workspaces[0].name, workspaceNameFromPath(repo));
  assert.equal(r.sessionWorkspaces.s1, r.workspaces[0].id);
});

test("sessions sharing a git root share one workspace", () => {
  const r = migrateGroupsToWorkspaces(
    {},
    new Map([
      ["s1", { cwd: path.join(repo, "web") }],
      ["s2", { cwd: path.join(repo, "agent") }]
    ]),
    io
  );
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.sessionWorkspaces.s1, r.sessionWorkspaces.s2);
});

test("a session outside any repo still gets a workspace at its own directory", () => {
  const dir = path.resolve("/tmp/x");
  const r = migrateGroupsToWorkspaces({}, new Map([["s1", { cwd: dir }]]), io);
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.workspaces[0].path, dir, "not every useful folder is a git repo");
  assert.equal(r.sessionWorkspaces.s1, r.workspaces[0].id);
});

test("a session with no cwd at all stays unassigned", () => {
  const r = migrateGroupsToWorkspaces({}, new Map([["s1", {}]]), io);
  assert.deepEqual(r.workspaces, []);
  assert.equal(r.sessionWorkspaces.s1, undefined);
});

test("a legacy group already holding that path is reused, not duplicated", () => {
  const r = migrateGroupsToWorkspaces(
    { groups: [{ id: "g1", name: "Repo", path: repo, createdAt: 1 }] },
    new Map([["s1", { cwd: path.join(repo, "web") }]]),
    io
  );
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.sessionWorkspaces.s1, "g1");
});

test("a session pointing at a deleted group falls through to its own directory", () => {
  const dir = path.resolve("/tmp/x");
  const r = migrateGroupsToWorkspaces(
    { groups: [], sessionGroups: { s1: "gone" } },
    new Map([["s1", { cwd: dir }]]),
    io
  );
  assert.equal(r.workspaces[0].path, dir, "the stale group id must not orphan the terminal");
});

test("every migrated session is pinned so a later cd cannot move it", () => {
  const r = migrateGroupsToWorkspaces(
    {},
    new Map([["s1", { cwd: path.join(repo, "web") }], ["s2", { cwd: path.join(repo, "agent") }]]),
    io
  );
  assert.equal(r.sessionPaths.s1, repo);
  assert.equal(r.sessionPaths.s2, repo);
});

test("commonAncestor finds the deepest shared directory, and refuses the root", () => {
  assert.equal(
    commonAncestor([path.resolve("/a/b/c"), path.resolve("/a/b/d")]),
    path.resolve("/a/b")
  );
  assert.equal(commonAncestor([path.resolve("/a"), path.resolve("/a")]), path.resolve("/a"));
  assert.equal(commonAncestor([]), null);
  assert.equal(commonAncestor([null, undefined]), null);
});

test("sessionOrder keeps only sessions that still exist", () => {
  const r = migrateGroupsToWorkspaces(
    { sessionOrder: ["s1", "dead", "s2"] },
    new Map([["s1", {}], ["s2", {}]]),
    io
  );
  assert.deepEqual(r.sessionOrder, ["s1", "s2"]);
});

test("migration is idempotent for the same path", () => {
  const sessions = new Map([["s1", { cwd: path.join(repo, "web") }]]);
  const first = migrateGroupsToWorkspaces({}, sessions, io);
  const second = migrateGroupsToWorkspaces(
    { groups: first.workspaces, sessionGroups: first.sessionWorkspaces },
    sessions,
    io
  );
  assert.equal(second.workspaces.length, 1);
  assert.equal(second.workspaces[0].id, first.workspaces[0].id);
  assert.equal(workspaceIdForPath(repo), first.workspaces[0].id);
});

test("plain-object session maps work too", () => {
  const r = migrateGroupsToWorkspaces({}, { s1: { cwd: repo } }, io);
  assert.equal(r.sessionWorkspaces.s1, workspaceIdForPath(repo));
});

test("no session is ever mapped to a workspace that was not created", () => {
  const cases = [
    [{ groups: [{ id: "g1", name: "X" }], sessionGroups: { s1: "g1" } }, new Map([["s1", {}]])],
    [{ groups: [{ id: "g1" }], sessionGroups: { s1: "g1", gone: "g1" } }, new Map([["s1", { cwd: repo }]])],
    [{ sessionGroups: { s1: "nope" } }, new Map([["s1", { cwd: repo }]])],
    [{}, new Map()]
  ];
  for (const [legacy, sessions] of cases) {
    const r = migrateGroupsToWorkspaces(legacy, sessions, io);
    const ids = new Set(r.workspaces.map((w) => w.id));
    for (const [sid, wsId] of Object.entries(r.sessionWorkspaces)) {
      assert.ok(ids.has(wsId), `${sid} points at a workspace that does not exist`);
    }
    for (const sid of Object.keys(r.sessionPaths)) {
      assert.ok(r.sessionWorkspaces[sid], `${sid} pinned to a path but has no workspace`);
    }
  }
});

test("a session already carrying workspacePath keeps that root", () => {
  const r = migrateGroupsToWorkspaces(
    {},
    new Map([["s1", { workspacePath: repo, cwd: path.resolve("/tmp/elsewhere") }]]),
    io
  );
  assert.equal(r.workspaces[0].path, repo, "an existing pin wins over the live cwd");
});

// ---- adopting loose terminals ----

test("a loose terminal joins the existing workspace at its git root", () => {
  const r = assignOrphanSessions({
    sessions: new Map([["s1", { cwd: path.join(repo, "web") }]]),
    workspaces: [{ id: "w1", path: repo }],
    sessionWorkspaces: {}
  }, io);
  assert.equal(r.assignments.s1, "w1");
  assert.deepEqual(r.created, [], "no workspace is invented for a path we already know");
});

test("loose terminals in the same repo pool into one new workspace", () => {
  const r = assignOrphanSessions({
    sessions: new Map([
      ["s1", { cwd: path.join(repo, "web") }],
      ["s2", { cwd: path.join(repo, "agent") }]
    ]),
    workspaces: [],
    sessionWorkspaces: {}
  }, io);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].path, repo);
  assert.equal(r.assignments.s1, r.assignments.s2);
});

test("terminals in unrelated directories do not get lumped together", () => {
  const bare = fakeIo(new Set());
  const r = assignOrphanSessions({
    sessions: new Map([
      ["s1", { cwd: path.resolve("/a/one") }],
      ["s2", { cwd: path.resolve("/b/two") }]
    ]),
    workspaces: [],
    sessionWorkspaces: {}
  }, bare);
  assert.equal(r.created.length, 2);
  assert.notEqual(r.assignments.s1, r.assignments.s2);
});

test("terminals that already have a workspace are left alone", () => {
  const r = assignOrphanSessions({
    sessions: new Map([["s1", { cwd: repo }]]),
    workspaces: [{ id: "w1", path: repo }],
    sessionWorkspaces: { s1: "w9" }
  }, io);
  assert.deepEqual(r.assignments, {}, "an existing assignment is never overridden");
});

test("a terminal with nowhere to go is left loose rather than swept somewhere", () => {
  const r = assignOrphanSessions({
    sessions: new Map([["s1", {}]]),
    workspaces: [],
    sessionWorkspaces: {}
  }, io);
  assert.deepEqual(r.assignments, {});
  assert.deepEqual(r.created, []);
});

test("adoption is idempotent — a second pass finds nothing left to do", () => {
  const sessions = new Map([["s1", { cwd: path.join(repo, "web") }]]);
  const first = assignOrphanSessions({ sessions, workspaces: [], sessionWorkspaces: {} }, io);
  const second = assignOrphanSessions({
    sessions, workspaces: first.created, sessionWorkspaces: first.assignments
  }, io);
  assert.deepEqual(second.assignments, {});
  assert.deepEqual(second.created, []);
});

test("a new workspace carries the id its path would migrate to", () => {
  const r = assignOrphanSessions({
    sessions: new Map([["s1", { cwd: repo }]]),
    workspaces: [],
    sessionWorkspaces: {}
  }, io);
  assert.equal(r.created[0].id, workspaceIdForPath(repo), "so migration and adoption agree");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
