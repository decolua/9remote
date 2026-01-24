import { parseApiKey, verifyApiKeyCrc } from "../apiKey.js";
import { createTunnel, deleteTunnel } from "../tunnelService.js";

/**
 * Handle POST /api/tunnel/create
 * CLI calls to get tunnel credentials
 */
export async function handleTunnelCreate(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  const { machineId } = parseApiKey(apiKey);

  try {
    const { tunnelId, token, hostname } = await createTunnel(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_KEY,
      env.CLOUDFLARE_EMAIL,
      machineId
    );

    // Update session with tunnelId
    await env.DB.prepare(`
      UPDATE sessions SET tunnelId = ?, tunnelUrl = ?
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
 * CLI calls on shutdown to cleanup tunnel
 */
export async function handleTunnelDelete(request, env, corsHeaders) {
  const { apiKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Invalid API key", 400, corsHeaders);
  }

  // Get tunnelId from session
  const session = await env.DB.prepare(`
    SELECT tunnelId FROM sessions WHERE apiKey = ?
  `).bind(apiKey).first();

  const { machineId } = parseApiKey(apiKey);

  if (session?.tunnelId) {
    try {
      await deleteTunnel(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_KEY,
        env.CLOUDFLARE_EMAIL,
        session.tunnelId,
        machineId
      );

      // Clear tunnelId from session
      await env.DB.prepare(`
        UPDATE sessions SET tunnelId = NULL, tunnelUrl = NULL
        WHERE apiKey = ?
      `).bind(apiKey).run();
    } catch (error) {
      console.error("Tunnel delete error:", error);
    }
  }

  return jsonResponse({ success: true }, corsHeaders);
}

// Helpers - reuse pattern from session.js
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
