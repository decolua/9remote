import fs from "fs";
import path from "path";
import os from "os";

const STATE_DIR = path.join(os.homedir(), ".9remote");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const KEYS_FILE = path.join(STATE_DIR, "keys.json");

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
 * Load keys from file
 * @returns {{ machineId: string, keys: Array<{ key: string, name: string, createdAt: string }> }}
 */
export function loadKeys() {
  try {
    ensureDir();
    if (!fs.existsSync(KEYS_FILE)) {
      return { machineId: null, keys: [] };
    }
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    return { machineId: null, keys: [] };
  }
}

/**
 * Save keys to file
 */
export function saveKeys(data) {
  try {
    ensureDir();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving keys:", error);
  }
}

/**
 * Add a new key
 */
export function addKey(machineId, key, name = "Default") {
  const data = loadKeys();
  data.machineId = machineId;
  data.keys.push({
    key,
    name,
    createdAt: new Date().toISOString()
  });
  saveKeys(data);
  return data;
}

/**
 * Delete a key by index
 */
export function deleteKey(index) {
  const data = loadKeys();
  if (index >= 0 && index < data.keys.length) {
    data.keys.splice(index, 1);
    saveKeys(data);
  }
  return data;
}

/**
 * Get default key (first one) or null
 */
export function getDefaultKey() {
  const data = loadKeys();
  return data.keys.length > 0 ? data.keys[0].key : null;
}
