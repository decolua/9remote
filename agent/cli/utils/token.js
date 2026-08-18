import { browserFetch } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("session");
const TEMP_KEY_EXPIRY_MINUTES = 30;

/**
 * Create temp key on Worker for API key
 * @param {string} apiKey - API key
 * @param {string} workerUrl - Worker URL
 * @returns {Promise<{tempKey: string, expiresAt: number} | null>}
 */
export async function createTempKey(apiKey, workerUrl) {
  try {
    const response = await browserFetch(`${workerUrl}/api/temp-key/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        apiKey, 
        expiryMinutes: TEMP_KEY_EXPIRY_MINUTES 
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    // logger, not console: the TUI clears the screen and the reason would be lost
    logger.error(`Temp key creation failed: ${error?.message || error}`);
    return null;
  }
}
