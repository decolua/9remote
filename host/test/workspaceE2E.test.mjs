// End-to-end over real git: build a repo with a nested repo and a worktree in a temp dir,
// then check the scan and the worktree/branch parsing against actual git output rather
// than fixtures. Fixtures drift from git; this does not.
// Run: node agent/test/workspaceE2E.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  scanRepos, parseWorktreeList, parseBranchList, terminalsInWorktree
} from "../features/fileExplorer/gitRepoScan.js";
import { findGitRoot, migrateGroupsToWorkspaces } from "../features/terminal/workspaceMigration.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---- fixture ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-ws-e2e-"));
const root = path.join(tmp, "main");
const nested = path.join(root, "packages", "lib");
const buried = path.join(root, "node_modules", "dep");
const wtPath = path.join(tmp, "wt-feature");

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "init"], dir);
}

try {
  initRepo(root);
  initRepo(nested);
  initRepo(buried);
  git(["branch", "feature"], root);
  git(["branch", "release/2.4"], root);
  git(["worktree", "add", "-q", wtPath, "feature"], root);

  // ---- scan ----

  test("scan finds the root and the nested repo", () => {
    const repos = scanRepos(root, { maxDepth: 2 });
    const rel = repos.map((r) => r.relPath).sort();
    assert.ok(rel.includes(""), "root repo");
    assert.ok(rel.includes(path.join("packages", "lib")), "nested repo");
  });

  test("scan never descends into node_modules", () => {
    const repos = scanRepos(root, { maxDepth: 4 });
    assert.ok(!repos.some((r) => r.path.includes("node_modules")), repos.map((r) => r.relPath).join(","));
  });

  test("scanning a plain directory that is not a repo yields nothing", () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain, { recursive: true });
    assert.deepEqual(scanRepos(plain, { maxDepth: 2 }), []);
  });

  // ---- worktrees ----

  test("real `git worktree list --porcelain` parses into main + linked", () => {
    const trees = parseWorktreeList(git(["worktree", "list", "--porcelain"], root));
    assert.equal(trees.length, 2);
    assert.equal(trees[0].isMain, true);
    assert.equal(trees[0].branch, "main");
    const linked = trees.find((w) => !w.isMain);
    assert.equal(linked.branch, "feature");
    assert.equal(fs.realpathSync(linked.path), fs.realpathSync(wtPath));
  });

  test("git refuses a second worktree on a checked-out branch, and we predict it", () => {
    const trees = parseWorktreeList(git(["worktree", "list", "--porcelain"], root));
    const branches = parseBranchList(
      git(["branch", "-a", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)"], root),
      trees
    );
    const byName = Object.fromEntries(branches.map((b) => [b.name, b]));
    assert.equal(byName.feature.checkedOut, true, "the UI must disable + worktree here");
    assert.equal(byName["release/2.4"].checkedOut, false);

    let refused = false;
    try { git(["worktree", "add", path.join(tmp, "dup"), "feature"], root); }
    catch { refused = true; }
    assert.ok(refused, "git itself refuses — our flag matched reality");
  });

  test("a local branch with a slash is not mistaken for a remote", () => {
    const branches = parseBranchList(
      git(["branch", "-a", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)"], root),
      []
    );
    assert.equal(branches.find((b) => b.name === "release/2.4").isRemote, false);
  });

  test("the current branch is the one git reports", () => {
    const branches = parseBranchList(
      git(["branch", "-a", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)"], root),
      []
    );
    const current = branches.find((b) => b.isCurrent)?.name;
    assert.equal(current, git(["branch", "--show-current"], root).trim());
  });

  // ---- terminals inside a worktree ----

  test("a terminal rooted in the worktree blocks a silent removal", () => {
    const sessions = [
      { id: "t1", name: "dev", workspacePath: wtPath },
      { id: "t2", name: "build", workspacePath: root }
    ];
    const busy = terminalsInWorktree(wtPath, sessions);
    assert.deepEqual(busy.map((s) => s.name), ["dev"]);
  });

  test("git removes the worktree once nothing holds it", () => {
    git(["worktree", "remove", wtPath], root);
    const trees = parseWorktreeList(git(["worktree", "list", "--porcelain"], root));
    assert.equal(trees.length, 1);
    assert.equal(terminalsInWorktree(wtPath, []).length, 0);
  });

  // ---- migration against the real tree ----

  test("findGitRoot walks a real nested path back to its repo", () => {
    assert.equal(fs.realpathSync(findGitRoot(path.join(nested, "..", "lib"))), fs.realpathSync(nested));
    assert.equal(fs.realpathSync(findGitRoot(path.join(root, "packages"))), fs.realpathSync(root));
  });

  test("ungrouped sessions migrate onto the repo they were sitting in", () => {
    const sessions = new Map([
      ["s1", { cwd: root }],
      ["s2", { cwd: path.join(root, "packages") }],
      ["s3", { cwd: nested }],
      ["s4", { cwd: os.tmpdir() }]
    ]);
    const out = migrateGroupsToWorkspaces({}, sessions);
    assert.equal(out.sessionWorkspaces.s1, out.sessionWorkspaces.s2, "same repo → same workspace");
    assert.notEqual(out.sessionWorkspaces.s1, out.sessionWorkspaces.s3, "nested repo is its own workspace");
    // A plain directory is still worth a workspace — the file tree and terminals work
    // there even without git.
    assert.ok(out.sessionWorkspaces.s4, "outside a repo it roots at its own directory");
    assert.equal(out.workspaces.length, 3);
  });

  test("every migrated session is pinned to a real directory on disk", () => {
    const out = migrateGroupsToWorkspaces({}, new Map([["s1", { cwd: path.join(root, "packages") }]]));
    const pinned = out.sessionPaths.s1;
    assert.ok(pinned, "a session with no workspacePath would show an empty tree");
    assert.ok(fs.existsSync(pinned), pinned);
    assert.equal(fs.realpathSync(pinned), fs.realpathSync(root));
  });

  test("a real legacy group is migrated onto the repo its terminals lived in", () => {
    const out = migrateGroupsToWorkspaces(
      { groups: [{ id: "g1", name: "My group", createdAt: 1 }], sessionGroups: { s1: "g1", s2: "g1" } },
      new Map([["s1", { cwd: root }], ["s2", { cwd: path.join(root, "packages") }]])
    );
    const ws = out.workspaces.find((w) => w.id === "g1");
    assert.equal(ws.name, "My group");
    assert.equal(fs.realpathSync(ws.path), fs.realpathSync(root));
    assert.equal(out.sessionWorkspaces.s1, "g1");
    assert.equal(out.sessionWorkspaces.s2, "g1");
  });

  test("no session is lost by migration", () => {
    const sessions = new Map([["a", { cwd: root }], ["b", {}], ["c", { cwd: "/nope" }]]);
    const out = migrateGroupsToWorkspaces({ sessionOrder: ["a", "b", "c"] }, sessions);
    assert.deepEqual(out.sessionOrder, ["a", "b", "c"], "order survives even for unassigned sessions");
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
