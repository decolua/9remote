import { parseApiKey, verifyApiKeyCrc } from "../apiKey.js";
import { decryptToken } from "../utils/token.js";

/**
 * Handle POST /api/session/create
 * Server gọi khi start - tạo session mới
 */
export async function handleSessionCreate(request, env, corsHeaders) {
  const { apiKey, shortId } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }
  const { machineId } = parseApiKey(apiKey);

  // UPSERT session - preserve shortId if exists
  await env.DB.prepare(`
    INSERT INTO sessions (machineId, apiKey, shortId, tunnelUrl, lastAccessAt, expiresAt)
    VALUES (?, ?, ?, NULL, datetime('now'), datetime('now', '+7 days'))
    ON CONFLICT(apiKey) 
    DO UPDATE SET 
      shortId = COALESCE(shortId, excluded.shortId),
      lastAccessAt = datetime('now'),
      expiresAt = datetime('now', '+7 days')
  `).bind(machineId, apiKey, shortId || null).run();

  return jsonResponse({ success: true, machineId }, corsHeaders);
}

/**
 * Handle POST /api/session/update
 * Server gọi sau khi có tunnel URL
 */
export async function handleSessionUpdate(request, env, corsHeaders) {
  const { apiKey, tunnelUrl, localIp } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  // CF-Connecting-IP is the real public IP of the caller (server machine)
  const publicIp = request.headers.get("CF-Connecting-IP") || null;

  await env.DB.prepare(`
    UPDATE sessions SET tunnelUrl = ?, publicIp = ?, localIp = ?, lastAccessAt = datetime('now')
    WHERE apiKey = ?
  `).bind(tunnelUrl, publicIp, localIp || null, apiKey).run();

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
    // Check if it's a temp key format (6 chars alphanumeric, case-insensitive)
    if (body.token.length <= 10 && /^[A-Z0-9]+$/i.test(body.token)) {
      // It's a temp key - convert to uppercase for database lookup
      const normalizedToken = body.token.toUpperCase();
      const tempKeyData = await env.DB.prepare(`
        SELECT api_key, expires_at FROM temp_keys WHERE temp_key = ?
      `).bind(normalizedToken).first();

      if (!tempKeyData) {
        return jsonError("Invalid or expired temp key", 401, corsHeaders);
      }

      if (Date.now() > tempKeyData.expires_at) {
        await env.DB.prepare(`DELETE FROM temp_keys WHERE temp_key = ?`).bind(normalizedToken).run();
        return jsonError("Temp key expired", 410, corsHeaders);
      }

      apiKey = tempKeyData.api_key;
      tempKey = normalizedToken;
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
    SELECT tunnelUrl, machineId, publicIp, localIp
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

  // Always return localIp — client probes it and falls back to tunnel if unreachable
  return jsonResponse({
    tunnelUrl: session.tunnelUrl,
    apiKey,
    tempKey,
    localIp: session.localIp || null
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
