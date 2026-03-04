import { verifyApiKeyCrc } from "../apiKey.js";

const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TTL = 86400; // 24h

/**
 * GET /api/webrtc/turn-credentials
 * Generate short-lived TURN credentials via Cloudflare TURN Key API
 * Auth: X-API-Key header
 */
export async function handleTurnCredentials(request, env, corsHeaders) {
  const apiKey = request.headers.get("X-API-Key");

  if (!apiKey || !(await verifyApiKeyCrc(apiKey))) {
    return jsonError("Unauthorized", 401, corsHeaders);
  }

  const resp = await fetch(
    `${TURN_API}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.TURN_KEY_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: TTL })
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    console.error("TURN credentials error:", err);
    return jsonError("Failed to generate TURN credentials", 502, corsHeaders);
  }

  const { iceServers } = await resp.json();

  return new Response(JSON.stringify({ iceServers }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function jsonError(message, status, corsHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
