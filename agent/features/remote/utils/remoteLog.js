// Config-driven logger for remote feature — routes through centralized logger.
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { createLogger } from "../../../lib/logger.js";

const cfg = () => REMOTE_CONFIG.logging;
const logger = createLogger("remote");

export const remoteLog = {
  lifecycle: (msg) => { if (cfg().lifecycle) logger.info(msg); },
  focus: (msg) => { if (cfg().focus) logger.info(msg); },
  dpi: (msg) => { if (cfg().dpiDetection) logger.info(msg); },
  error: (msg, err) => { if (cfg().errors) logger.error(`${msg} ${err?.message || err || ""}`); },
  warn: (msg) => { if (cfg().errors) logger.warn(msg); },
};
