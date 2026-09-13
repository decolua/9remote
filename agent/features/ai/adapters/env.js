// Environment for spawning agent CLIs (claude, codex, opencode).
// A GUI/tray/daemon launch inherits a minimal PATH — the shells' profile is never
// sourced — so the CLIs and their runtime binaries are found only if we add the
// usual install locations ourselves.
import os from "node:os";
import path from "node:path";

// The PTY's session id, which every notify hook reads to say which terminal it came
// from. A chat UI process gets it too, or the CLI's own hooks fire with no session to
// report and the chat stays invisible to status, naming and push.
export const SESSION_ID_ENV = "NINE_REMOTE_SESSION_ID";

export function getExtendedEnv({ hostSessionId } = {}) {
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
  return {
    ...process.env,
    PATH: combinedPath,
    FORCE_COLOR: "1",
    // Always set, never inherited: an agent started from one of our own terminals has
    // that terminal's id in its own env, and a chat spawning from here would report its
    // hooks under a session it is not. Empty is the "no session" every hook reads.
    [SESSION_ID_ENV]: hostSessionId || ""
  };
}
