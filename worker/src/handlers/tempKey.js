import { verifyApiKeyCrc } from "../apiKey.js";

const TEMP_KEY_LENGTH = 6;
const TEMP_KEY_EXPIRY_MINUTES = 30;

/**
 * Generate random temp key (6 chars uppercase)
 */
function generateTempKey() {
  const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
  let result = "";
  for (let i = 0; i < TEMP_KEY_LENGTH; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Handle POST /api/temp-key/create
 * Create temp key for API key (replace old one if exists)
 */
export async function handleTempKeyCreate(request, env, corsHeaders) {
  try {
    const { apiKey, expiryMinutes = TEMP_KEY_EXPIRY_MINUTES } = await request.json();

    if (!apiKey || !(await verifyApiKeyCrc(apiKey))) {
      return jsonError("Invalid API key", 400, corsHeaders);
    }

    // Delete old temp key for this API key (if exists)
    await env.DB.prepare(`DELETE FROM temp_keys WHERE api_key = ?`).bind(apiKey).run();

    // Generate new temp key
    let tempKey;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      tempKey = generateTempKey();
      
      // Check if temp key already exists
      const existing = await env.DB.prepare(`
        SELECT temp_key FROM temp_keys WHERE temp_key = ?
      `).bind(tempKey).first();

      if (!existing) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return jsonError("Failed to generate unique temp key", 500, corsHeaders);
    }

    const now = Date.now();
    const expiresAt = now + expiryMinutes * 60 * 1000;

    // Insert new temp key
    await env.DB.prepare(`
      INSERT INTO temp_keys (temp_key, api_key, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(tempKey, apiKey, expiresAt, now).run();

    return jsonResponse({
      tempKey,
      expiresAt,
      expiryMinutes
    }, corsHeaders);
  } catch (error) {
    console.error("Error creating temp key:", error);
    return jsonError(error.message, 500, corsHeaders);
  }
}

/**
 * Handle GET /api/temp-key/verify?k=abc123
 * Verify temp key and return API key
 */
export async function handleTempKeyVerify(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const tempKey = url.searchParams.get("k");

    if (!tempKey) {
      return jsonError("Missing temp key", 400, corsHeaders);
    }

    const result = await env.DB.prepare(`
      SELECT api_key, expires_at
      FROM temp_keys
      WHERE temp_key = ?
    `).bind(tempKey).first();

    if (!result) {
      return jsonError("Invalid temp key", 404, corsHeaders);
    }

    // Check expiry
    if (Date.now() > result.expires_at) {
      // Delete expired key
      await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(tempKey).run();
      return jsonError("Temp key expired", 410, corsHeaders);
    }

    return jsonResponse({
      apiKey: result.api_key,
      tempKey
    }, corsHeaders);
  } catch (error) {
    console.error("Error verifying temp key:", error);
    return jsonError(error.message, 500, corsHeaders);
  }
}

/**
 * Handle DELETE /api/temp-key/remove
 * Remove temp key (called by server after client connected)
 */
export async function handleTempKeyRemove(request, env, corsHeaders) {
  try {
    const { tempKey } = await request.json();

    if (!tempKey) {
      return jsonError("Missing temp key", 400, corsHeaders);
    }

    const result = await env.DB.prepare(`
      DELETE FROM temp_keys WHERE temp_key = ?
    `).bind(tempKey).run();

    return jsonResponse({
      success: true,
      removed: result.meta.changes > 0
    }, corsHeaders);
  } catch (error) {
    console.error("Error removing temp key:", error);
    return jsonError(error.message, 500, corsHeaders);
  }
}

// Helpers
function jsonResponse(data, corsHeaders) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function jsonError(message, status, corsHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
