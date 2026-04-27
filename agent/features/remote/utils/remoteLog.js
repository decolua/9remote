// Config-driven logger for remote feature — routes through centralized logger.
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { log } from "../../../lib/logger.js";

const cfg = () => REMOTE_CONFIG.logging;

export const remoteLog = {
  lifecycle: (msg) => { if (cfg().lifecycle) log("remote", msg); },
  focus: (msg) => { if (cfg().focus) log("remote", msg); },
  dpi: (msg) => { if (cfg().dpiDetection) log("remote", msg); },
  error: (msg, err) => { if (cfg().errors) log("remote-error", `${msg} ${err?.message || err || ""}`); },
  warn: (msg) => { if (cfg().errors) log("remote-warn", msg); }
};
