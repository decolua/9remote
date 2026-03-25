import fs from "fs";
import path from "path";
import os from "os";

const STATE_DIR = path.join(os.homedir(), ".9remote");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const KEYS_FILE = path.join(STATE_DIR, "keys.json");
const CMD_FILE = path.join(STATE_DIR, "cmd.json");

/**
 * Ensure state directory exists
 */
function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

// ==================== STATE ====================

/**
 * Load state from file
 */
export function loadState() {
  try {
    ensureDir();
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save state to file
 */
export function saveState(state) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Error saving state:", error);
  }
}

/**
 * Clear state file
 */
export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch {}
}

// ==================== KEYS ====================

/**
 * Load single key from file
 * @returns {{ machineId: string, key: string | null, name: string, createdAt: string | null }}
 */
export function loadKey() {
  try {
    ensureDir();
    if (!fs.existsSync(KEYS_FILE)) {
      return { machineId: null, key: null, name: "Default", createdAt: null };
    }
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    return { machineId: null, key: null, name: "Default", createdAt: null };
  }
}

// ==================== IPC CMD ====================

/** Write a command for CLI to pick up */
export function writeCmd(cmd) {
  try {
    ensureDir();
    fs.writeFileSync(CMD_FILE, JSON.stringify({ cmd, ts: Date.now() }));
  } catch {}
}

/** Read and clear pending command (returns null if none) */
export function readAndClearCmd() {
  try {
    if (!fs.existsSync(CMD_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CMD_FILE, "utf8"));
    fs.unlinkSync(CMD_FILE);
    return data.cmd;
  } catch {
    return null;
  }
}

/**
 * Save single key to file (overwrites existing)
 */
export function saveKey(machineId, key, name = "Default") {
  try {
    ensureDir();
    const data = {
      machineId,
      key,
      name,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error("Error saving key:", error);
    return null;
  }
}
