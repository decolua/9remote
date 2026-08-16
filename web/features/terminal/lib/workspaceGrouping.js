// Grouping sessions into workspaces for the sidebar, and the display path shown
// next to a workspace name.
import { sessionWorkspaceId } from "./paneLayout.js";

// "/Users/me/x" -> "~/x". Home is only ever a prefix of a full segment.
export function shortenHomePath(fullPath, home) {
  if (!fullPath) return "";
  if (!home) return fullPath;
  if (fullPath === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return fullPath.startsWith(prefix) ? `~/${fullPath.slice(prefix.length)}` : fullPath;
}

/**
 * Bucket sessions by workspace, in workspace order, with the unassigned ones last.
 * Grouping keys off the session's workspace, never its live cwd — a `cd` inside a
 * terminal must not move it to another workspace.
 *
 * @param {Array} sessions
 * @param {Array} workspaces  [{id, name, path}]
 * @param {string} ungroupedLabel
 * @returns {Array<{id, name, path, items}>}
 */
export function groupSessionsByWorkspace(sessions = [], workspaces = [], ungroupedLabel = "Ungrouped") {
  const buckets = new Map();
  for (const s of sessions) {
    const id = sessionWorkspaceId(s);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(s);
  }

  const ordered = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path || null,
    items: buckets.get(w.id) || []
  }));

  const unassigned = buckets.get(null);
  if (unassigned?.length) ordered.push({ id: null, name: ungroupedLabel, path: null, items: unassigned });
  return ordered;
}

// Path a workspace's git state should be read from: its own root, else the fixed
// workspacePath of any session in it (a workspace migrated from a group has no path).
export function workspaceGitPath(workspace) {
  if (workspace?.path) return workspace.path;
  return workspace?.items?.find((s) => s.workspacePath)?.workspacePath || null;
}
