// Artifact = a file the AI asks the app to show. The AI creates the file itself;
// this only decides whether that file may be shown, and which terminal it belongs to.
import fs from "fs";
import path from "path";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { isSensitivePath } from "../fileExplorer/pathGuard.js";
import { listSessionRoots } from "../terminal/terminalSocket.js";

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const fold = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
const isUnder = (child, parent) => {
  const c = fold(child), p = fold(parent);
  return c === p || c.startsWith(p + path.sep);
};

const rootsOf = (s) => [s.cwd, s.workspacePath].filter(Boolean);

// Which terminal the panel belongs to. The caller's own session id is the answer whenever
// the probe found one — several terminals can share a repo, so the path cannot tell them
// apart. Falling back to the path picks the deepest matching root: a worktree or subfolder
// terminal is a better guess than the repo-root one it is nested inside.
function ownerSession(filePath, callerSessionId, holders) {
  if (callerSessionId && holders.some((s) => s.id === callerSessionId)) return callerSessionId;
  let best = null, bestLen = -1;
  for (const s of holders) {
    for (const root of rootsOf(s)) {
      if (isUnder(filePath, root) && root.length > bestLen) { best = s.id; bestLen = root.length; }
    }
  }
  return best;
}

export function openArtifact({ path: rawPath, title }, callerSessionId = null) {
  if (!rawPath || typeof rawPath !== "string") return { error: "path is required" };

  // Resolve symlinks before every check — a link inside a workspace must not read
  // as "inside" when its target is not.
  let filePath = path.resolve(rawPath);
  try { filePath = fs.realpathSync(filePath); } catch { return { error: "File not found" }; }

  if (isSensitivePath(filePath)) return { error: "Access denied" };
  if (!fs.statSync(filePath).isFile()) return { error: "Not a file" };

  // The path jail: the file must sit inside an open terminal's workspace or cwd. A known
  // caller is jailed to its own roots; an unknown one to any open terminal's.
  const live = listSessionRoots();
  const holders = live.filter((s) => rootsOf(s).some((root) => isUnder(filePath, root)));
  if (callerSessionId && live.some((s) => s.id === callerSessionId)
      && !holders.some((s) => s.id === callerSessionId)) {
    return { error: "File is outside this terminal's workspace" };
  }
  if (!holders.length) return { error: "File is outside every open terminal's workspace" };

  const io = getIO();
  if (!io) return { error: "Server not ready" };
  const sessionId = ownerSession(filePath, callerSessionId, holders);
  broadcast(io, "artifactOpen", { path: filePath, title: title || path.basename(filePath), sessionId });
  return { path: filePath };
}
