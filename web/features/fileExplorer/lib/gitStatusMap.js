// Git status → path map with parent-folder propagation.
// Both explorers need "this folder contains changes" badges, and each had its own
// copy of the walk (with different loop directions and payload shapes). One
// implementation, so a fix lands in both.

/**
 * Build `{ relativePath: status }` from a gitStatus() result, marking every parent
 * directory of a changed file as "folder-changed".
 * Accepts both payload shapes seen from the agent: {path,status} and {file,code}.
 * `prefix` re-keys a nested repo's entries under their path relative to the workspace.
 */
export function buildGitStatusMap(result, prefix = "") {
  if (!result?.success) return {};
  const list = result.files || result.status || [];
  const map = {};
  for (const entry of list) {
    const rel = entry?.path || entry?.file;
    const status = entry?.status || entry?.code;
    if (!rel || !status) continue;
    map[prefix + rel] = status;
    // Mark ancestors so a collapsed folder still shows it has changes inside.
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = prefix + parts.slice(0, i).join("/");
      if (!map[parent]) map[parent] = "folder-changed";
    }
  }
  return map;
}

/**
 * Status map for a workspace that may not be a repo itself — a parent folder holding
 * nested repos. Tries the root first (fast path, one call); on failure scans for
 * nested repos and merges each one's status re-keyed under its relPath, so the keys
 * still match relativeTo(workspace, file.path) in both trees.
 * Returns { hasGit, map }: hasGit is true for a repo root OR any nested repo.
 */
export async function buildWorkspaceGitStatus(fileBus, workspace) {
  const root = await fileBus.gitStatus(workspace);
  if (root?.success) return { hasGit: true, map: buildGitStatusMap(root) };

  const scan = await fileBus.gitScanRepos?.(workspace);
  const repos = (scan?.success ? scan.repos : []) || [];
  const maps = await Promise.all(repos.map(async (repo) => {
    // Windows agents send relPath with backslashes; map keys are forward-slash.
    const rel = String(repo.relPath || "").split("\\").join("/");
    if (!rel) return null; // the root itself — already tried and failed above
    const res = await fileBus.gitStatus(repo.path);
    if (!res?.success) return null;
    const map = buildGitStatusMap(res, `${rel}/`);
    if (Object.keys(map).length) map[rel] ||= "folder-changed";
    return map;
  }));
  const merged = Object.assign({}, ...maps.filter(Boolean));
  return { hasGit: maps.some(Boolean), map: merged };
}

/**
 * Shallow-equal check used to keep the previous object reference when nothing
 * changed — the map feeds every row, so a new reference re-renders the whole tree.
 */
export function sameStatusMap(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of kb) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
