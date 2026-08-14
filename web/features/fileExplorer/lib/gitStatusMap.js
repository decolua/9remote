// Git status → path map with parent-folder propagation.
// Both explorers need "this folder contains changes" badges, and each had its own
// copy of the walk (with different loop directions and payload shapes). One
// implementation, so a fix lands in both.

/**
 * Build `{ relativePath: status }` from a gitStatus() result, marking every parent
 * directory of a changed file as "folder-changed".
 * Accepts both payload shapes seen from the agent: {path,status} and {file,code}.
 */
export function buildGitStatusMap(result) {
  if (!result?.success) return {};
  const list = result.files || result.status || [];
  const map = {};
  for (const entry of list) {
    const rel = entry?.path || entry?.file;
    const status = entry?.status || entry?.code;
    if (!rel || !status) continue;
    map[rel] = status;
    // Mark ancestors so a collapsed folder still shows it has changes inside.
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (!map[parent]) map[parent] = "folder-changed";
    }
  }
  return map;
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
