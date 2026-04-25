import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".9remote");
const LOG_FILE = path.join(LOG_DIR, "tunnel.log");

export function tunnelLog(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const TUNNEL_LOG_FILE = LOG_FILE;
