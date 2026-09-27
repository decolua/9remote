// Nested-repo scan + worktree/branch parsing. The scan runs on user-chosen folders, so
// the bounds (depth, skip list, wall clock) are the correctness property here — an
// unbounded walk over a home directory is what makes the UI hang.
// Run: node agent/test/gitRepoScan.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import {
  scanRepos, scanReposCached, invalidateRepoScan, parseWorktreeList, parseBranchList,
  terminalsInWorktree, isRepo, SCAN_SKIP_DIRS, SCAN_DEFAULTS
} from "../features/fileExplorer/gitRepoScan.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// In-memory fs: paths is a Set of existing paths, dirs maps dir -> child names.
function fakeIo(paths, dirs) {
  return {
    existsSync: (p) => paths.has(p),
    readdirSync: (p) => (dirs[p] || []).map((name) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false
    }))
  };
}

const R = path.resolve("/root");
const j = (...p) => path.join(...p);

test("the root itself is reported when it is a repo", () => {
  const io = fakeIo(new Set([j(R, ".git")]), { [R]: [] });
  const repos = scanRepos(R, { io });
  assert.equal(repos.length, 1);
  assert.equal(repos[0].path, R);
  assert.equal(repos[0].relPath, "", "the root gets an empty relPath");
});

test("a non-repo root yields nothing rather than erroring", () => {
  const io = fakeIo(new Set(), { [R]: [] });
  assert.deepEqual(scanRepos(R, { io }), []);
  assert.deepEqual(scanRepos(null, { io }), []);
});

test("a repo one level down is found with a relative path", () => {
  const io = fakeIo(
    new Set([j(R, ".git"), j(R, "app", ".git")]),
    { [R]: ["app"], [j(R, "app")]: [] }
  );
  assert.deepEqual(scanRepos(R, { io }).map((r) => r.relPath).sort(), ["", "app"]);
});

test("the default depth stops at one level, so a folder of clones stays shallow", () => {
  const io = fakeIo(
    new Set([j(R, ".git"), j(R, "packages", "app", ".git")]),
    { [R]: ["packages"], [j(R, "packages")]: ["app"], [j(R, "packages", "app")]: [] }
  );
  assert.deepEqual(scanRepos(R, { io }).map((r) => r.relPath), [""], "packages/app is out of reach");
  assert.equal(SCAN_DEFAULTS.maxDepth, 1);
});

test("the deep scan reaches a monorepo's packages/*/ repos", () => {
  const io = fakeIo(
    new Set([j(R, ".git"), j(R, "packages", "app", ".git")]),
    { [R]: ["packages"], [j(R, "packages")]: ["app"], [j(R, "packages", "app")]: [] }
  );
  const repos = scanRepos(R, { io, maxDepth: SCAN_DEFAULTS.deepMaxDepth });
  assert.deepEqual(repos.map((r) => r.relPath).sort(), ["", path.join("packages", "app")]);
});

test("a deep scan is not served from the shallow scan's cache", () => {
  invalidateRepoScan();
  const io = fakeIo(
    new Set([j(R, ".git"), j(R, "packages", "app", ".git")]),
    { [R]: ["packages"], [j(R, "packages")]: ["app"], [j(R, "packages", "app")]: [] }
  );
  const now = () => 1000;
  assert.equal(scanReposCached(R, { io, now }).length, 1);
  assert.equal(scanReposCached(R, { io, now, maxDepth: 3 }).length, 2, "depth is part of the key");
  assert.equal(scanReposCached(R, { io, now }).length, 1, "and the shallow entry survives");
});

test("invalidate clears every depth cached for that root", () => {
  invalidateRepoScan();
  let reads = 0;
  const io = { existsSync: () => { reads++; return false; }, readdirSync: () => [] };
  const now = () => 1000;
  scanReposCached(R, { io, now });
  scanReposCached(R, { io, now, maxDepth: 3 });
  const after = reads;
  invalidateRepoScan(R);
  scanReposCached(R, { io, now });
  scanReposCached(R, { io, now, maxDepth: 3 });
  assert.ok(reads > after, "both depths re-walked");
});

test("depth bounds the walk", () => {
  const deep = j(R, "a", "b", "c");
  const io = fakeIo(
    new Set([j(deep, ".git")]),
    { [R]: ["a"], [j(R, "a")]: ["b"], [j(R, "a", "b")]: ["c"], [deep]: [] }
  );
  assert.equal(scanRepos(R, { io, maxDepth: 2 }).length, 0, "depth 3 repo is out of reach");
  assert.equal(scanRepos(R, { io, maxDepth: 3 }).length, 1);
});

test("node_modules and friends are never descended into", () => {
  const io = fakeIo(
    new Set([j(R, "node_modules", "pkg", ".git")]),
    { [R]: ["node_modules"], [j(R, "node_modules")]: ["pkg"], [j(R, "node_modules", "pkg")]: [] }
  );
  assert.deepEqual(scanRepos(R, { io, maxDepth: 5 }), []);
  for (const d of ["node_modules", ".git", "dist", ".next", "venv", "target"]) {
    assert.ok(SCAN_SKIP_DIRS.has(d), `${d} should be skipped`);
  }
});

test("an unreadable directory is skipped, not fatal", () => {
  const io = {
    existsSync: (p) => p === j(R, ".git"),
    readdirSync: (p) => { if (p === R) return [{ name: "secret", isDirectory: () => true, isSymbolicLink: () => false }]; throw new Error("EACCES"); }
  };
  const repos = scanRepos(R, { io });
  assert.equal(repos.length, 1, "the root repo still comes back");
});

test("symlinked directories are not followed", () => {
  const io = {
    existsSync: (p) => p === j(R, "link", ".git"),
    readdirSync: () => [{ name: "link", isDirectory: () => true, isSymbolicLink: () => true }]
  };
  assert.deepEqual(scanRepos(R, { io }), []);
});

test("the wall clock stops a long scan", () => {
  let t = 0;
  const io = fakeIo(new Set(), { [R]: ["a"], [j(R, "a")]: [] });
  const repos = scanRepos(R, { io, timeoutMs: 0, now: () => (t += 10) });
  assert.deepEqual(repos, [], "deadline already passed before the first pop");
});

test("the cache serves a second scan and the TTL expires it", () => {
  invalidateRepoScan();
  let reads = 0;
  const io = {
    existsSync: () => { reads++; return false; },
    readdirSync: () => []
  };
  let t = 1000;
  const opts = { io, now: () => t, cacheTtlMs: 30000 };
  scanReposCached(R, opts);
  const after = reads;
  scanReposCached(R, opts);
  assert.equal(reads, after, "second call within TTL does no disk work");
  t += 31000;
  scanReposCached(R, opts);
  assert.ok(reads > after, "past the TTL it walks again");
});

test("invalidate forces the next scan to re-walk", () => {
  invalidateRepoScan();
  let reads = 0;
  const io = { existsSync: () => { reads++; return false; }, readdirSync: () => [] };
  const opts = { io, now: () => 1000 };
  scanReposCached(R, opts);
  const after = reads;
  invalidateRepoScan(R);
  scanReposCached(R, opts);
  assert.ok(reads > after);
});

test("isRepo tolerates a throwing fs", () => {
  assert.equal(isRepo("/x", { existsSync: () => { throw new Error("boom"); } }), false);
});

// ---- worktree list ----

const WT_PORCELAIN = `worktree /Users/me/9remote
HEAD abc123
branch refs/heads/main

worktree /Users/me/wt/feat-auth
HEAD def456
branch refs/heads/feat-auth

worktree /Users/me/wt/detached
HEAD 99aa00
detached
`;

test("worktree list parses paths and short branch names", () => {
  const trees = parseWorktreeList(WT_PORCELAIN);
  assert.equal(trees.length, 3);
  assert.equal(trees[0].path, "/Users/me/9remote");
  assert.equal(trees[0].branch, "main", "refs/heads/ prefix is stripped");
  assert.equal(trees[0].isMain, true, "the first record is the main worktree");
  assert.equal(trees[1].isMain, false);
});

test("a detached worktree has no branch and is flagged", () => {
  const trees = parseWorktreeList(WT_PORCELAIN);
  assert.equal(trees[2].branch, null);
  assert.equal(trees[2].detached, true);
});

test("worktree list handles empty and trailing-newline-free input", () => {
  assert.deepEqual(parseWorktreeList(""), []);
  const one = parseWorktreeList("worktree /a\nHEAD z\nbranch refs/heads/x");
  assert.equal(one.length, 1, "a final record with no trailing blank line still counts");
  assert.equal(one[0].branch, "x");
});

// ---- branch list ----

const BRANCHES = [
  "refs/heads/main\tmain\torigin/main\t*",
  "refs/heads/feat-auth\tfeat-auth\t\t",
  "refs/heads/release/2.4\trelease/2.4\t\t",
  "refs/remotes/origin/experimental\torigin/experimental\t\t",
  "refs/remotes/origin/HEAD\torigin/HEAD -> origin/main\t\t"
].join("\n");

test("branch list separates local from remote by refname, not by slash", () => {
  const b = parseBranchList(BRANCHES, []);
  const byName = Object.fromEntries(b.map((x) => [x.name, x]));
  assert.equal(byName["release/2.4"].isRemote, false, "a local branch may contain a slash");
  assert.equal(byName["origin/experimental"].isRemote, true);
});

test("the origin/HEAD alias is dropped", () => {
  const b = parseBranchList(BRANCHES, []);
  assert.ok(!b.some((x) => x.name.includes("->")));
});

test("branches already held by a worktree are marked checked out", () => {
  const trees = parseWorktreeList(WT_PORCELAIN);
  const b = parseBranchList(BRANCHES, trees);
  const byName = Object.fromEntries(b.map((x) => [x.name, x]));
  assert.equal(byName.main.checkedOut, true);
  assert.equal(byName["feat-auth"].checkedOut, true);
  assert.equal(byName["release/2.4"].checkedOut, false, "free to get a new worktree");
});

test("the current branch is flagged", () => {
  const b = parseBranchList(BRANCHES, []);
  assert.equal(b.find((x) => x.name === "main").isCurrent, true);
});

test("duplicate branch lines collapse", () => {
  const dup = "refs/heads/main\tmain\t\t*\nrefs/heads/main\tmain\t\t*";
  assert.equal(parseBranchList(dup, []).length, 1);
});

// ---- worktree removal safety ----

test("terminals rooted in a worktree are found so removal can warn", () => {
  const sessions = [
    { id: "a", workspacePath: "/Users/me/wt/feat-auth" },
    { id: "b", workspacePath: "/Users/me/wt/feat-auth/web" },
    { id: "c", workspacePath: "/Users/me/9remote" },
    { id: "d", cwd: "/Users/me/wt/feat-auth/agent" }
  ];
  const hit = terminalsInWorktree("/Users/me/wt/feat-auth", sessions);
  assert.deepEqual(hit.map((s) => s.id), ["a", "b", "d"]);
});

test("a sibling path with a shared name prefix is not a match", () => {
  const sessions = [{ id: "x", workspacePath: "/Users/me/wt/feat-auth-2" }];
  assert.deepEqual(terminalsInWorktree("/Users/me/wt/feat-auth", sessions), []);
});

test("sessions with no path at all are ignored", () => {
  assert.deepEqual(terminalsInWorktree("/a", [{ id: "x" }]), []);
  assert.deepEqual(terminalsInWorktree("/a", []), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
