// A permission grant as the lines a person decides on.
//
// Codex can ask for more access than the thread opened with — the network, or paths
// outside the sandbox — and it says so as a PROFILE (the server's own
// `RequestPermissionProfile`: `network` and `fileSystem`), not as a command line. Printed
// raw, a profile is a wall of nulls; what a reader needs is the two or three facts it
// amounts to, next to the CLI's own sentence about why it is asking.
//
// The shapes are the server's, read off `codex app-server generate-ts`:
//   network     { enabled: boolean | null }
//   fileSystem  { read: string[], write: string[], entries?: FileSystemSandboxEntry[] }
//   entry.path  { type: "path", path } | { type: "glob_pattern", pattern } | { type: "special", value }
//
// Returns "" for anything that is not a grant, so the caller can fall through to the
// command line every other gate carries.
export function permissionGrantText(input) {
  if (input?.kind !== "permission_grant") return "";
  const lines = [];
  const reason = String(input.reason || "").trim();
  if (reason) lines.push(reason);
  lines.push(...permissionLines(input.permissions));
  return lines.join("\n");
}

/** The profile's own facts, one per line. Exported for the test. */
export function permissionLines(permissions = {}) {
  const out = [];
  // `enabled: null` is the server saying nothing either way, which is not a request.
  if (permissions?.network?.enabled) out.push("• network access");
  const fs = permissions?.fileSystem || {};
  for (const p of fs.read || []) out.push(`• read ${p}`);
  for (const p of fs.write || []) out.push(`• write ${p}`);
  for (const e of fs.entries || []) {
    const where = pathText(e?.path);
    if (where) out.push(`• ${e.access || "access"} ${where}`);
  }
  return out;
}

/** A `FileSystemPath` as one string — the three spellings it comes in. */
function pathText(p) {
  if (typeof p === "string") return p;
  return p?.path || p?.pattern || p?.value || "";
}
