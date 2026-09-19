// read_terminal — the conductor's look over a worker's shoulder. The daemon keeps
// each session's scrollback; this fetches the newest chunk and strips the ANSI
// clutter, so Jarvis reads what a worker actually printed without a terminal.
import { requestHistory } from "../../../features/terminal/ptyDaemonClient.js";
import { cleanTerminalOutput, TERMINAL_READ_DEFAULT_LINES } from "../../../features/jarvis/terminalText.js";

const MAX_LINES = 200;

export function makeReadTerminalTool(deps = { fetchHistory: requestHistory }) {
  return {
    name: "read_terminal",
    description:
      "Read the last lines of a session's terminal scrollback, with ANSI clutter stripped. Use it to check " +
      "what a worker actually printed — test results, errors, git output — when its status alone is not " +
      `enough. Lines: how many trailing lines (default ${TERMINAL_READ_DEFAULT_LINES}, max ${MAX_LINES}). ` +
      "Full-screen TUI apps (vim, htop) do not read cleanly.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session to read (a sessionId from list_fleet)" },
        lines: { type: "number", description: `Trailing lines to return (default ${TERMINAL_READ_DEFAULT_LINES}, max ${MAX_LINES})` }
      },
      required: ["sessionId"]
    },
    async run({ sessionId, lines } = {}) {
      if (!sessionId) return { error: "sessionId is required" };
      const maxLines = Math.max(1, Math.min(Number(lines) || TERMINAL_READ_DEFAULT_LINES, MAX_LINES));
      let res;
      try {
        res = await deps.fetchHistory(sessionId, 0);
      } catch (e) {
        return { error: `cannot reach the terminal daemon: ${e.message}` };
      }
      if (!res?.success) return { error: res?.error || "session not found" };
      if (!res.prefix) return "";
      return cleanTerminalOutput(Buffer.from(res.prefix, "base64").toString("utf8"), { maxLines });
    }
  };
}

export default makeReadTerminalTool();
