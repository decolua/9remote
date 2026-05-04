import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { getConsistentMachineId } from "../utils/machineId.js";
import { generateApiKeyWithMachine } from "../utils/apiKey.js";
import { loadKey, saveKey } from "../utils/state.js";
import { isCodespaces } from "../../features/terminal/codespaceManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function ensureKeyData() {
  const machineId = await getConsistentMachineId();
  // In Codespaces, use NREMOTE_API_KEY injected via Codespace secret so web/agent share the same key.
  if (isCodespaces() && process.env.NREMOTE_API_KEY) {
    return saveKey(machineId, process.env.NREMOTE_API_KEY, "Codespace");
  }
  let keyData = loadKey();
  if (!keyData.key) {
    const { key } = generateApiKeyWithMachine(machineId);
    keyData = saveKey(machineId, key, "Default");
  }
  return keyData;
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
