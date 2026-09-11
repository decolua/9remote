// Paths in AI tool cards arrive as absolute paths: long, and identical in the leading
// segments across a whole run of cards. Display drops the workspace prefix and, when the
// path is still too deep, keeps the trailing segments and marks the dropped front with a
// leading ellipsis — the file name is the part that carries meaning.
//
// The renderer keeps the file name intact and lets only the directory part shrink. CSS
// ellipsis alone cannot do that, because it always cuts the end (the name), so the
// directory half carries its own head-ellipsis class (see .path-head in globals.css).

// How many trailing segments to keep when the path does not fit.
const MAX_SEGMENTS = 4;
// Inside the workspace the prefix is already gone, so one more segment fits.
const WORKSPACE_SEGMENTS = MAX_SEGMENTS + 1;

/**
 * Split a path for display.
 * @param {string} filePath Full path as reported by the CLI.
 * @param {string} [base] The terminal's workspace path, if known.
 * @returns {{dir: string, name: string}} Directory (without a trailing slash, empty for
 *   a bare file name) and the file name, which callers must render unclipped.
 */
export function splitPath(filePath, base) {
  if (typeof filePath !== "string" || !filePath) return { dir: "", name: "" };

  const normalized = filePath.replace(/\\/g, "/");
  const cleanBase = base ? base.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const inWorkspace = Boolean(cleanBase) && normalized.startsWith(`${cleanBase}/`);
  const maxSegments = inWorkspace ? WORKSPACE_SEGMENTS : MAX_SEGMENTS;
  let segments = (inWorkspace ? normalized.slice(cleanBase.length + 1) : normalized)
    .split("/")
    .filter(Boolean);

  if (segments.length > maxSegments) segments = ["…", ...segments.slice(-maxSegments)];

  const name = segments.pop() || "";
  return { dir: segments.join("/"), name };
}

/**
 * Shorten a path to one string. Kept for callers that only need the text form
 * (a tooltip, a title attribute).
 */
export function shortenPath(filePath, base) {
  const { dir, name } = splitPath(filePath, base);
  return dir ? `${dir}/${name}` : name;
}
