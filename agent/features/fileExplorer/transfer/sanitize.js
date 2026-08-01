// Sanitize client-supplied relative path so it can never escape targetDir.
// Client sends forward-slash relative paths (from webkitGetAsEntry); we resolve
// them on the agent's filesystem and verify the result stays inside targetDir.
import path from "node:path";

const posix = path.posix;

// Reject paths that could resolve outside the target directory.
// Throws on anything suspicious; returns the normalized posix path otherwise.
export function sanitizeRelativePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("Empty relative path");
  // No backslashes (Windows separators / UNC). Client should send posix paths.
  if (/[\\]/.test(rel)) throw new Error("Backslash not allowed");
  // No drive letters (C:\...) or absolute paths.
  if (/^[a-zA-Z]:/.test(rel)) throw new Error("Drive path not allowed");
  if (posix.isAbsolute(rel)) throw new Error("Absolute path not allowed");

  const norm = posix.normalize(rel);
  if (norm === "." || norm === "") throw new Error("Invalid path");
  if (norm.startsWith("../")) throw new Error("Traversal not allowed");

  // Reject any ".." segment surviving normalization.
  for (const seg of norm.split("/")) {
    if (seg === "..") throw new Error("Traversal not allowed");
  }
  return norm;
}

// Resolve targetDir + relativePath to an absolute, in-bounds path.
// Throws if the joined path escapes targetDir.
export function resolveSafePath(targetDir, relativePath) {
  const safe = sanitizeRelativePath(relativePath);
  const joined = posix.join(targetDir, safe);
  if (joined !== targetDir && !joined.startsWith(targetDir + "/")) {
    throw new Error("Resolved path escapes target directory");
  }
  return joined;
}
