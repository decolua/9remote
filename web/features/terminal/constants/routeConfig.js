// Workspace route <-> view mapping (single source of truth for URL sync)

export const WORKSPACE_BASE = "/workspace";

// View type -> URL builder. Path carries primary id; query carries extra data.
export const VIEW_TO_PATH = {
  list: () => WORKSPACE_BASE,
  terminal: (v) => `${WORKSPACE_BASE}/terminal/${encodeURIComponent(v.sessionId || "")}`,
  files: (v) => withQuery(`${WORKSPACE_BASE}/files`, { ws: v.workspace, p: v.currentPath }),
  editor: (v) => withQuery(`${WORKSPACE_BASE}/editor`, { path: v.path, line: v.line, col: v.column }),
  git: (v) => withQuery(`${WORKSPACE_BASE}/git`, { ws: v.workspace }),
  remote: () => `${WORKSPACE_BASE}/remote`,
  mobile: () => `${WORKSPACE_BASE}/mobile`,
  workspaces: () => `${WORKSPACE_BASE}/workspaces`,
  browse: (v) => withQuery(`${WORKSPACE_BASE}/browse`, { path: v.path })
};

// Views rendered as a store-only overlay: never mirrored into the URL. The site
// browser's iframe piles its own entries onto the parent history, so keeping it
// out of history is the only way Back stays predictable.
export const OVERLAY_VIEWS = ["site"];

// First path segment after base -> view type
export const SEGMENT_TO_TYPE = {
  "": "list",
  terminal: "terminal",
  files: "files",
  editor: "editor",
  git: "git",
  remote: "remote",
  mobile: "mobile",
  workspaces: "workspaces",
  browse: "browse"
};

// Build "?a=b" string, skipping empty values
function withQuery(path, params) {
  const qs = Object.entries(params)
    .filter(([, val]) => val != null && val !== "")
    .map(([k, val]) => `${k}=${encodeURIComponent(val)}`)
    .join("&");
  return qs ? `${path}?${qs}` : path;
}

// Parse a workspace URL into a view object (null = not a workspace route)
export function pathToView(pathname, searchParams) {
  if (!pathname?.startsWith(WORKSPACE_BASE)) return null;
  const rest = pathname.slice(WORKSPACE_BASE.length).replace(/^\//, "");
  const [segment, idPart] = rest.split("/");
  const type = SEGMENT_TO_TYPE[segment || ""];
  if (!type) return null;
  const q = (key) => searchParams?.get(key) || undefined;
  switch (type) {
    case "terminal": return { type, sessionId: idPart ? decodeURIComponent(idPart) : undefined };
    case "files": return { type, workspace: q("ws"), currentPath: q("p") };
    case "editor": return { type, path: q("path"), line: numOrUndef(q("line")), column: numOrUndef(q("col")) };
    case "git": return { type, workspace: q("ws") };
    case "browse": return { type, path: q("path") };
    default: return { type };
  }
}

// Build URL string from a view object
export function viewToPath(view) {
  const build = VIEW_TO_PATH[view?.type] || VIEW_TO_PATH.list;
  return build(view);
}

// Resolve a view parsed from the URL against the current stack.
// Returns the stack to adopt, or null when the view is a genuinely new level (push it).
export function stackForUrl(viewStack, view) {
  const target = viewToPath(view);
  // The URL names a view the stack already holds lower down (Back out of files/editor):
  // cut back to that entry. Pushing instead left a duplicate terminal above the original,
  // so the next Back landed on the old terminal — which reads as a tab switch.
  const seen = viewStack.findIndex((v) => viewToPath(v) === target);
  if (seen !== -1) return viewStack.slice(0, seen + 1);
  if (view.type === "terminal" && viewStack[viewStack.length - 1]?.type === "terminal") {
    // Tab switch within terminal view = same level, replace top instead of growing stack
    const next = [...viewStack];
    next[next.length - 1] = view;
    return next;
  }
  return null;
}

function numOrUndef(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}
