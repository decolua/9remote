// The daemon's route table: one entry per thing an agent may ask it to do.
//
// This file is the contract between the two processes. It is pure data plus a pure
// resolver, so it can be copied into the daemon's runtime folder (see
// ptyDaemonClient's DAEMON_LOCAL_MODULES) and read by tests without a socket.
//
// `reply` names the message type the answer is sent as; a route without one is
// fire-and-forget (the terminal's own input/resize — the ack would be pure overhead on
// the typing hot path, and the caller has nothing to do with it).
//
// `coalesce` groups a route into a last-wins slot per session: a burst of the same
// request collapses to its final message. Only idempotent routes may use it — typing
// never can, or characters would be dropped.
export const ROUTES = {
  "terminal.ping": { reply: "pong", coalesce: null },
  "terminal.listSessions": { reply: "sessionList", coalesce: null },
  "terminal.createSession": { reply: "createResult", coalesce: null },
  "terminal.joinSession": { reply: "joinResult", coalesce: null },
  "terminal.requestHistory": { reply: "historyResult", coalesce: null },
  "terminal.input": { reply: null, coalesce: null },
  // A drag produces dozens of sizes; intermediate widths make the PTY re-wrap, and a
  // narrow one damages the scrollback for good. Only the final size is applied.
  "terminal.resize": { reply: null, coalesce: "resize" },
  "terminal.deleteSession": { reply: "deleteResult", coalesce: null },
  "terminal.getCwd": { reply: "cwdResult", coalesce: null },
  "proc.start": { reply: "procStartResult", coalesce: null },
  "proc.attach": { reply: "procAttachResult", coalesce: null },
  "proc.lines": { reply: "procLinesResult", coalesce: null },
  "proc.write": { reply: "procWriteResult", coalesce: null },
  "proc.signal": { reply: "procSignalResult", coalesce: null },
  "proc.stop": { reply: "procStopResult", coalesce: null },
  "proc.list": { reply: "procListResult", coalesce: null },
};

// Wire names shipped before the router existed. A new daemon has to keep answering
// them: an agent that is a version behind is still holding live terminals, and renaming
// a route would drop every one of them. Remove an alias only once no supported agent
// sends it.
export const ALIASES = {
  ping: "terminal.ping",
  listSessions: "terminal.listSessions",
  createSession: "terminal.createSession",
  joinSession: "terminal.joinSession",
  requestHistory: "terminal.requestHistory",
  input: "terminal.input",
  resize: "terminal.resize",
  deleteSession: "terminal.deleteSession",
  getCwd: "terminal.getCwd",
  procStart: "proc.start",
  procAttach: "proc.attach",
  procLines: "proc.lines",
  procWrite: "proc.write",
  procSignal: "proc.signal",
  procStop: "proc.stop",
  procList: "proc.list",
};

/** Wire name → route key, or null when nothing serves it. */
export function resolveRoute(type) {
  if (ROUTES[type]) return type;
  return ALIASES[type] || null;
}
