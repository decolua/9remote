// Config-driven logger for remote feature. Routes to console + TUI log panel.
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { pushUiLog } from "../../../api/ui.js";

const cfg = () => REMOTE_CONFIG.logging;

function emit(msg) {
  console.log(msg);
  pushUiLog(msg);
}

export const remoteLog = {
  lifecycle: (msg) => { if (cfg().lifecycle) emit(msg); },
  focus: (msg) => { if (cfg().focus) emit(msg); },
  dpi: (msg) => { if (cfg().dpiDetection) console.log(msg); },
  error: (msg, err) => { if (cfg().errors) console.error(msg, err?.message || err || ""); },
  warn: (msg) => { if (cfg().errors) console.warn(msg); }
};
