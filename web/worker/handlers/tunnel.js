import { parseApiKey, verifyApiKeyCrc } from "../apiKey.js";
import { createTunnel, deleteTunnel } from "../tunnelService.js";

/**
 * Handle POST /api/tunnel/create
 */
export async function handleTunnelCreate(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  const { machineId } = parseApiKey(apiKey);

  // Get shortId from session (set by CLI on session/create)
  const session = await env.DB.prepare(`
    SELECT shortId FROM sessions WHERE apiKey = ?
  `).bind(apiKey).first();

  if (!session?.shortId) {
    return jsonError("Session missing shortId", 400, corsHeaders);
  }

  try {
    const { tunnelId, token, hostname } = await createTunnel(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_KEY,
      env.CLOUDFLARE_EMAIL,
      machineId,
      session.shortId
    );

    await env.DB.prepare(`
      UPDATE sessions SET tunnelId = ?, tunnelUrl = ?, lastAccessAt = datetime('now')
      WHERE apiKey = ?
    `).bind(tunnelId, hostname, apiKey).run();

    return jsonResponse({ tunnelId, token, hostname }, corsHeaders);
  } catch (error) {
    console.error("Tunnel create error:", error);
    return jsonError(error.message, 500, corsHeaders);
  }
}

/**
 * Handle DELETE /api/tunnel/delete
 */
export async function handleTunnelDelete(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  const session = await env.DB.prepare(`
    SELECT tunnelId, shortId FROM sessions WHERE apiKey = ?
  `).bind(apiKey).first();

  if (session?.tunnelId) {
    try {
      await deleteTunnel(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_KEY,
        env.CLOUDFLARE_EMAIL,
        session.tunnelId,
        session.shortId
      );

      await env.DB.prepare(`
        UPDATE sessions SET tunnelId = NULL, tunnelUrl = NULL WHERE apiKey = ?
      `).bind(apiKey).run();
    } catch (error) {
      console.error("Tunnel delete error:", error);
    }
  }

  return jsonResponse({ success: true }, corsHeaders);
}

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
