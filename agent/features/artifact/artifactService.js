// Artifact = a file the AI asks the app to show. The AI creates the file itself;
// this only decides whether that file may be shown.
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

// The path jail: the file must sit inside some open terminal's workspace or cwd.
// Which terminal is deliberately not reported — the panel opens beside whichever
// terminal the user has selected, and that selection is theirs, not the AI's.
function isInsideAnyTerminal(filePath) {
  return listSessionRoots().some((s) =>
    [s.cwd, s.workspacePath].some((root) => root && isUnder(filePath, root)));
}

export function openArtifact({ path: rawPath, title }) {
  if (!rawPath || typeof rawPath !== "string") return { error: "path is required" };

  // Resolve symlinks before every check — a link inside a workspace must not read
  // as "inside" when its target is not.
  let filePath = path.resolve(rawPath);
  try { filePath = fs.realpathSync(filePath); } catch { return { error: "File not found" }; }

  if (isSensitivePath(filePath)) return { error: "Access denied" };
  if (!fs.statSync(filePath).isFile()) return { error: "Not a file" };

  if (!isInsideAnyTerminal(filePath)) return { error: "File is outside every open terminal's workspace" };

  const io = getIO();
  if (!io) return { error: "Server not ready" };
  broadcast(io, "artifactOpen", { path: filePath, title: title || path.basename(filePath) });
  return { path: filePath };
}
