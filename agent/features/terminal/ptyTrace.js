// Terminal latency tracer.
// - Agent process → agent.log + /logs SSE (via lib/logger createLogger), survives TUI clears.
// - Daemon process (separate) → console → daemon.log (daemon sets _9REMOTE_DAEMON=1).
// Toggle off: TRACE_TTY=0 env. Remove once root cause is found.
let _logger = null;
let _initStarted = false;

function initLogger() {
  if (_initStarted) return;
  _initStarted = true;
  // Daemon is a separate process spawned with ptyDaemon.js as main script → console only (→ daemon.log).
  // Agent main process uses lib/logger (agent.log + /logs SSE, survives TUI console clears).
  const main = process.argv[1] || "";
  if (main.includes("ptyDaemon")) return;
  import("../../lib/logger.js")
    .then(({ createLogger }) => { _logger = createLogger("trace"); })
    .catch(() => {});
}

export function trace(point, extra = "") {
  if (process.env.TRACE_TTY === "0") return;
  if (!_logger && !_initStarted) initLogger();
  const line = `${point} ${extra}`;
  if (_logger) _logger.info(line);
  else console.log(`[trace] ${line}`); // before logger resolves (first few calls) or daemon
}
