import { browserFetch } from "../../lib/constants.js";

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
      const error = await response.json();
      throw new Error(error.error || "Failed to create temp key");
    }

    return await response.json();
  } catch (error) {
    console.error("Error creating temp key:", error);
    return null;
  }
}
