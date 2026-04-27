import { log, LOG_FILE_PATH } from "../../lib/logger.js";

export function tunnelLog(msg) { log("tunnel", msg); }

export const TUNNEL_LOG_FILE = LOG_FILE_PATH;
