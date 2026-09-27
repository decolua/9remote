// Nested-repo discovery and `git worktree` parsing. Kept free of socket wiring so it
// can be unit-tested against a real temp repo.
import fs from "fs";
import path from "path";

// Directories never worth descending into. node_modules alone can hold thousands of
// entries and occasionally a vendored .git, which would make the scan both slow and wrong.
export const SCAN_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".open-next", ".venv", "venv",
  "target", "vendor", ".cache", "out", "coverage", ".turbo", "__pycache__", ".gradle"
]);

// Depth 1 by default: a workspace often sits above a pile of read-only clones, and
// listing every one of them buries the repo actually being worked on. "Scan deeper" in
// the panel raises this for monorepos whose real repos live at packages/*/.
export const SCAN_DEFAULTS = { maxDepth: 1, deepMaxDepth: 3, timeoutMs: 5000, cacheTtlMs: 30000 };

const _scanCache = new Map(); // rootPath → { ts, repos }

export const isRepo = (dir, io = fs) => {
  try { return io.existsSync(path.join(dir, ".git")); } catch { return false; }
};

/**
 * Find git repos at or under rootPath, breadth-first, bounded by depth and wall clock.
 * The root itself is included when it is a repo. Descends INTO a repo too — a monorepo
 * can hold nested repos or submodules the user still wants listed.
 *
 * @returns {Array<{path, relPath, depth}>}
 */
export function scanRepos(rootPath, {
  maxDepth = SCAN_DEFAULTS.maxDepth,
  timeoutMs = SCAN_DEFAULTS.timeoutMs,
  now = () => Date.now(),
  io = fs
} = {}) {
  if (!rootPath) return [];
  const root = path.resolve(rootPath);
  const deadline = now() + timeoutMs;
  const found = [];
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length) {
    if (now() > deadline) break;
    const { dir, depth } = queue.shift();
    if (isRepo(dir, io)) {
      found.push({ path: dir, relPath: dir === root ? "" : path.relative(root, dir), depth });
    }
    if (depth >= maxDepth) continue;

    let entries;
    try { entries = io.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

// Depth is part of the key: a deep scan must not be served from a shallow one's result.
const cacheKey = (rootPath, maxDepth) =>
  `${path.resolve(rootPath || "")}::${maxDepth ?? SCAN_DEFAULTS.maxDepth}`;

// Same as scanRepos, memoized per root+depth. A tree expand must not re-walk the disk.
export function scanReposCached(rootPath, opts = {}) {
  const now = opts.now || (() => Date.now());
  const ttl = opts.cacheTtlMs ?? SCAN_DEFAULTS.cacheTtlMs;
  const key = cacheKey(rootPath, opts.maxDepth);
  const hit = _scanCache.get(key);
  if (hit && now() - hit.ts < ttl) return hit.repos;
  const repos = scanRepos(rootPath, opts);
  _scanCache.set(key, { ts: now(), repos });
  return repos;
}

// Drops every depth cached for that root, so "refresh" means refresh at any depth.
export function invalidateRepoScan(rootPath) {
  if (!rootPath) return _scanCache.clear();
  const prefix = `${path.resolve(rootPath)}::`;
  for (const key of _scanCache.keys()) {
    if (key.startsWith(prefix)) _scanCache.delete(key);
  }
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated; the main
 * worktree comes first. A detached worktree has no branch, a locked one is flagged.
 */
export function parseWorktreeList(stdout = "") {
  const trees = [];
  let cur = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) { if (cur) { trees.push(cur); cur = null; } continue; }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") cur = { path: value, branch: null, head: null, detached: false, locked: false, bare: false };
    else if (!cur) continue;
    else if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "locked") cur.locked = true;
    else if (key === "bare") cur.bare = true;
  }
  if (cur) trees.push(cur);
  return trees.map((tree, i) => ({ ...tree, isMain: i === 0 }));
}

/**
 * Parse `git branch -a --format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)`.
 * The full refname tells local from remote without guessing at slashes — a local branch
 * may legitimately be named `feature/x`. Marks branches a worktree already occupies,
 * since git refuses to check the same branch out twice.
 */
export function parseBranchList(stdout = "", worktrees = []) {
  const taken = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const seen = new Set();
  const branches = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.includes("->")) continue; // skip the origin/HEAD -> origin/main alias
    const [refname, name, upstream, headMark] = line.split("\t");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    branches.push({
      name,
      upstream: upstream || null,
      isRemote: (refname || "").startsWith("refs/remotes/"),
      isCurrent: headMark === "*",
      checkedOut: taken.has(name)
    });
  }
  return branches;
}

// Terminals whose fixed workspacePath sits inside a worktree. Removing that worktree
// would pull the ground out from under them, so the caller must warn first.
export function terminalsInWorktree(worktreePath, sessions = []) {
  const root = path.resolve(worktreePath);
  return sessions.filter((s) => {
    const base = s?.workspacePath || s?.cwd;
    if (!base) return false;
    const resolved = path.resolve(base);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}
