import pkg from "node-machine-id";
const { machineIdSync } = pkg;
import crypto from "crypto";

/**
 * Get consistent machine ID using node-machine-id with salt
 * This ensures the same physical machine gets the same ID across runs
 * 
 * @param {string} salt - Optional salt to use (defaults to environment variable)
 * @returns {Promise<string>} Machine ID (16-character hex)
 */
export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || "9remote-salt";
  try {
    const rawMachineId = machineIdSync();
    const hashedMachineId = crypto.createHash("sha256").update(rawMachineId + saltValue).digest("hex");
    return hashedMachineId.substring(0, 16);
  } catch (error) {
    console.error("Error getting machine ID:", error);
    return crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  }
}
