// group -> workspace migration + git-root discovery.
// Kept free of PATHS/IO wiring so it can be unit-tested with an injected fs.
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

// How far up from a session cwd we look for a .git before giving up.
const GIT_ROOT_MAX_DEPTH = 24;

// Nearest ancestor directory (cwd included) holding a .git entry. null when none.
export function findGitRoot(cwd, io = fs) {
  if (!cwd || typeof cwd !== "string") return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < GIT_ROOT_MAX_DEPTH; i++) {
    try {
      if (io.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export const workspaceNameFromPath = (p) =>
  path.basename(p) || p;

// Deterministic id so re-running migration never duplicates a workspace for the same path.
// Hashed, not truncated: two deep paths sharing a long prefix (a temp dir, a monorepo)
// would collide if the encoded path were simply cut short.
export const workspaceIdForPath = (p) =>
  `ws_${createHash("sha1").update(path.resolve(p)).digest("hex").slice(0, 16)}`;

// Deepest directory containing every one of the given paths. Used to turn a group whose
// terminals sit in the same tree into a workspace rooted at that tree.
export function commonAncestor(paths = []) {
  const usable = paths.filter(Boolean).map((p) => path.resolve(p));
  if (!usable.length) return null;
  let parts = usable[0].split(path.sep);
  for (const p of usable.slice(1)) {
    const other = p.split(path.sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join(path.sep);
  // A single leading "" means we walked back to the filesystem root — too broad to be a
  // useful workspace, so treat it as "no common root".
  if (!joined || joined === "" || parts.filter(Boolean).length === 0) return null;
  return joined;
}

// The path a set of sessions should root at: their shared git repo if they agree on one,
// else the deepest directory they all live under.
function rootForSessions(sessionList, io) {
  const cwds = sessionList.map((s) => s?.workspacePath || s?.cwd).filter(Boolean);
  if (!cwds.length) return null;

  const repos = new Set();
  for (const cwd of cwds) {
    const repo = findGitRoot(cwd, io);
    if (repo) repos.add(path.resolve(repo));
  }
  if (repos.size === 1) return [...repos][0];
  if (repos.size > 1) return commonAncestor([...repos]);
  return commonAncestor(cwds);
}

/**
 * Build the workspace state from legacy group state plus live session cwds.
 *
 * Every workspace comes out with a real path — a path-less workspace would show an empty
 * file tree and no git, which is worse than the group it replaced. A group's path is
 * inferred from where its own terminals are; an ungrouped session gets the workspace of
 * its nearest git root, else of its own directory.
 *
 * @param {{groups?:Array, sessionGroups?:Object, sessionOrder?:Array}} legacy
 * @param {Map<string,{cwd?:string}>|Object} sessions
 * @returns {{workspaces:Array, sessionWorkspaces:Object, sessionPaths:Object, sessionOrder:Array}}
 */
export function migrateGroupsToWorkspaces(legacy = {}, sessions = new Map(), io = fs) {
  const entries = sessions instanceof Map ? [...sessions.entries()] : Object.entries(sessions || {});
  const sessionById = new Map(entries);

  const byId = new Map();
  const byPath = new Map();
  const sessionWorkspaces = {};

  const claimPath = (resolved, name, createdAt, preferredId) => {
    const existing = byPath.get(resolved);
    if (existing) return existing;
    const id = preferredId || workspaceIdForPath(resolved);
    byPath.set(resolved, id);
    byId.set(id, { id, name: name || workspaceNameFromPath(resolved), path: resolved, createdAt: createdAt || Date.now() });
    return id;
  };

  // Legacy groups first, so their user-chosen names survive.
  for (const g of legacy.groups || []) {
    if (!g?.id) continue;
    const members = Object.entries(legacy.sessionGroups || {})
      .filter(([, gid]) => gid === g.id)
      .map(([sid]) => sessionById.get(sid))
      .filter(Boolean);

    const root = g.path ? path.resolve(g.path) : rootForSessions(members, io);
    // A group whose terminals are all gone leaves nothing to infer a path from; drop it
    // rather than keep a workspace that can never show a tree.
    if (!root) continue;

    const id = claimPath(root, g.name || g.id, g.createdAt, g.id);
    for (const [sid, gid] of Object.entries(legacy.sessionGroups || {})) {
      if (gid === g.id && sessionById.has(sid)) sessionWorkspaces[sid] = id;
    }
  }

  // Then everything still unassigned, by its own git root (or its own directory).
  for (const [sessionId, session] of entries) {
    if (sessionWorkspaces[sessionId]) continue;
    const root = rootForSessions([session], io);
    if (!root) continue;
    sessionWorkspaces[sessionId] = claimPath(root, null, session?.createdAt);
  }

  // Pin each session to its workspace root so a later `cd` cannot move it.
  const sessionPaths = {};
  for (const [sessionId, workspaceId] of Object.entries(sessionWorkspaces)) {
    const wsPath = byId.get(workspaceId)?.path;
    if (wsPath) sessionPaths[sessionId] = wsPath;
  }

  // Keep only ids we still know about; migration must never invent order entries.
  const knownSessions = new Set(entries.map(([id]) => id));
  const sessionOrder = (legacy.sessionOrder || []).filter((id) => knownSessions.has(id));

  return { workspaces: [...byId.values()], sessionWorkspaces, sessionPaths, sessionOrder };
}
