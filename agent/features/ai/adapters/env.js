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

// Claude Code only checkpoints files in the interactive TUI; under the SDK entrypoint
// (which is how we drive it) the feature is off unless this is set. Without it no
// `file-history-snapshot` is written and `--rewind-files` has nothing to restore.
// Read by the claude CLI alone — other engines ignore it.
export const CLAUDE_FILE_CHECKPOINTING_ENV = "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING";

// The name the CLI stamps into a transcript's records, and the one `/resume` reads when
// deciding whether to list it. It rewrites `cli` to `sdk-cli` whenever stdin is not a TTY
// (which driving it with stream-json always is), so asking for `cli` does not work —
// verified on 2.1.270. A value it does not recognise is honoured VERBATIM, and any value
// outside PROGRAMMATIC_ENTRYPOINTS is listed by the TUI's /resume.
export const CLAUDE_ENTRYPOINT_ENV = "CLAUDE_CODE_ENTRYPOINT";
export const PROGRAMMATIC_ENTRYPOINTS = ["sdk-cli", "sdk-ts", "sdk-py"];
// Deliberately not "cli" (rewritten) and not one of the above (filtered out of /resume).
const CHAT_ENTRYPOINT = "9remote";

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
    [SESSION_ID_ENV]: hostSessionId || "",
    [CLAUDE_FILE_CHECKPOINTING_ENV]: "true",
    // Stamped so the chat's transcript is one the TUI's /resume will list. Without it the
    // CLI defaults to `sdk-cli`, and `/resume` hides every programmatic transcript — the
    // chat and the TUI then keep separate histories of the same conversation.
    [CLAUDE_ENTRYPOINT_ENV]: CHAT_ENTRYPOINT
  };
}
