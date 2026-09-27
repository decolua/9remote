import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyV2, isApiKeyV2, isLegacyApiKey } from "../utils/apiKey.js";
import { loadKey, saveKey, loadSettings } from "../utils/state.js";
import { registerSession } from "../utils/token.js";
import { isServerRunning } from "../core/localApi.js";
import { WORKER_URL } from "../config.js";
import { isCodespaces } from "../../features/terminal/codespaceManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function ensureKeyData() {
  const machineId = await getConsistentMachineId();
  // In Codespaces, use NREMOTE_API_KEY injected via Codespace secret so web/host share the same key.
  if (isCodespaces() && process.env.NREMOTE_API_KEY) {
    return saveKey(machineId, process.env.NREMOTE_API_KEY, "Codespace");
  }
  let keyData = loadKey();
  if (!keyData.key) {
    // New installs get a v2 key (routing-only; entry needs the per-device secret)
    const key = generateApiKeyV2(machineId);
    keyData = saveKey(machineId, key, "Default");
  } else if (isLegacyApiKey(keyData.key)) {
    keyData = await upgradeLegacyKey(machineId, keyData);
  }
  return keyData;
}

// v1 is rejected worker-side — swap it for v2 once, treating the machine as fresh.
async function upgradeLegacyKey(machineId, keyData) {
  // tui/auto reach this before their guest check: never swap the key under a running owner.
  if (await isServerRunning()) return keyData;
  const key = generateApiKeyV2(machineId);
  if (loadSettings().remoteEnabled === false) return saveKey(machineId, key, keyData.name || "Default");
  // Best-effort: an offline boot still swaps — boot session/create or QR mint re-registers later.
  await registerSession(key, WORKER_URL, null, keyData.key);
  const now = loadKey();
  if (isApiKeyV2(now.key)) return now; // lost the double-boot race — adopt the winner's key
  return saveKey(machineId, key, keyData.name || "Default");
}

export function getVersion() {
  if (typeof __CLI_VERSION__ !== "undefined") return __CLI_VERSION__;
  try {
    const packagePath = path.join(__dirname, "..", "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return packageJson.version;
  } catch {
    return "unknown";
  }
}
