// Environment for spawning agent CLIs (claude, codex, opencode).
// A GUI/tray/daemon launch inherits a minimal PATH — the shells' profile is never
// sourced — so the CLIs and their runtime binaries are found only if we add the
// usual install locations ourselves.
import os from "node:os";
import path from "node:path";

export function getExtendedEnv() {
  const home = os.homedir();
  const extraPaths = process.platform === "win32" ? [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs"),
    path.join(home, ".cargo", "bin"),
  ] : [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    // The running Node's own bin dir — never hardcode a version, the user may
    // upgrade and the old path would silently stop resolving.
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  const envPath = (process.env.PATH || "").split(path.delimiter);
  const combinedPath = Array.from(new Set([...extraPaths, ...envPath])).join(path.delimiter);
  return { ...process.env, PATH: combinedPath, FORCE_COLOR: "1" };
}
