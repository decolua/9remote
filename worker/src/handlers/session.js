import { parseApiKey, verifyApiKeyCrc } from "../apiKey.js";
import { decryptToken } from "../utils/token.js";

/**
 * Handle POST /api/session/create
 * Server gọi khi start - tạo session mới
 */
export async function handleSessionCreate(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  const { machineId } = parseApiKey(apiKey);

  // Delete old session if exists
  await env.DB.prepare(`DELETE FROM sessions WHERE machineId = ?`).bind(machineId).run();

  // Create new session (tunnelUrl will be updated later)
  await env.DB.prepare(`
    INSERT INTO sessions (machineId, apiKey, tunnelUrl, lastAccessAt)
    VALUES (?, ?, NULL, datetime('now'))
  `).bind(machineId, apiKey).run();

  return jsonResponse({ success: true, machineId }, corsHeaders);
}

/**
 * Handle POST /api/session/update
 * Server gọi sau khi có tunnel URL
 */
export async function handleSessionUpdate(request, env, corsHeaders) {
  const { apiKey, tunnelUrl } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  await env.DB.prepare(`
    UPDATE sessions SET tunnelUrl = ?, lastAccessAt = datetime('now')
    WHERE apiKey = ?
  `).bind(tunnelUrl, apiKey).run();

  return jsonResponse({ success: true }, corsHeaders);
}

/**
 * Handle POST /api/connect
 * User gọi khi nhập key hoặc quét QR - lấy tunnel URL
 */
export async function handleConnect(request, env, corsHeaders) {
  const body = await request.json();
  let apiKey;
  let tempKey = body.tempKey || null;

  // Support: tempKey (new), token (old encrypted), or direct apiKey (manual entry)
  if (body.token) {
    // Check if it's a temp key format (6 chars uppercase alphanumeric)
    if (body.token.length <= 10 && /^[A-Z0-9]+$/.test(body.token)) {
      // It's a temp key
      const tempKeyData = await env.DB.prepare(`
        SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?
      `).bind(body.token).first();

      if (!tempKeyData) {
        return jsonError("Invalid or expired temp key", 401, corsHeaders);
      }

      if (Date.now() > tempKeyData.expires_at) {
        await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(body.token).run();
        return jsonError("Temp key expired", 410, corsHeaders);
      }

      apiKey = tempKeyData.api_key;
      tempKey = body.token;
    } else {
      // Old encrypted token
      const payload = decryptToken(body.token);
      if (!payload) {
        return jsonError("Invalid or expired token", 401, corsHeaders);
      }
      apiKey = payload.key;
    }
  } else if (body.apiKey) {
    apiKey = body.apiKey;
  } else {
    return jsonError("Missing token or apiKey", 400, corsHeaders);
  }

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 401, corsHeaders);
  }

  const session = await env.DB.prepare(`
    SELECT tunnelUrl, machineId 
    FROM sessions 
    WHERE apiKey = ? AND expiresAt > datetime('now')
  `).bind(apiKey).first();

  if (!session) {
    return jsonError("Session not found or expired", 404, corsHeaders);
  }

  if (!session.tunnelUrl) {
    return jsonError("Server not ready. Please wait...", 503, corsHeaders);
  }

  await env.DB.prepare(`
    UPDATE sessions SET lastAccessAt = datetime('now') WHERE apiKey = ?
  `).bind(apiKey).run();

  return jsonResponse({
    tunnelUrl: session.tunnelUrl,
    apiKey,
    tempKey
  }, corsHeaders);
}

/**
 * Handle DELETE /api/session/delete
 */
export async function handleSessionDelete(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  await env.DB.prepare(`DELETE FROM sessions WHERE apiKey = ?`).bind(apiKey).run();

  return jsonResponse({ success: true }, corsHeaders);
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
