import { handleStaticAsset } from "./handlers/static.js";
import { handleSessionCreate, handleSessionUpdate, handleConnect, handleSessionDelete } from "./handlers/session.js";
import { handleTempKeyCreate, handleTempKeyVerify, handleTempKeyRemove } from "./handlers/tempKey.js";
import { handleTunnelCreate, handleTunnelDelete } from "./handlers/tunnel.js";
import { handleVersion } from "./handlers/version.js";
import { cleanupDeadTunnels } from "./tunnelService.js";

// CORS headers
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Static files (GET)
      if (request.method === "GET") {
        return handleStaticAsset(request, env, corsHeaders);
      }

      // API routes
      if (pathname.startsWith("/api/")) {
        return handleAPI(request, pathname, env);
      }

      // 404
      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (error) {
      console.error("Worker error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  },

  // Scheduled cleanup (runs every hour)
  async scheduled(event, env, ctx) {
    try {
      // Clean expired sessions
      const sessionsResult = await env.DB.prepare(`
        DELETE FROM sessions WHERE expiresAt < datetime('now')
      `).run();

      // Clean expired temp keys
      const tempKeysResult = await env.DB.prepare(`
        DELETE FROM temp_keys WHERE expires_at < ?
      `).bind(Date.now()).run();

      // Clean dead tunnels (down/inactive/degraded)
      const tunnelCleanup = await cleanupDeadTunnels(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_KEY,
        env.CLOUDFLARE_EMAIL
      );

      console.log(`Cleanup: ${sessionsResult.meta.changes} sessions, ${tempKeysResult.meta.changes} temp keys, ${tunnelCleanup} tunnels`);
    } catch (error) {
      console.error("Scheduled cleanup error:", error);
    }
  }
};

/**
 * Handle API routes
 */
async function handleAPI(request, pathname, env) {
  // GET /api/version
  if (request.method === "GET" && pathname === "/api/version") {
    return handleVersion(request, env);
  }

  // POST /api/session/create
  if (request.method === "POST" && pathname === "/api/session/create") {
    return handleSessionCreate(request, env, corsHeaders);
  }

  // POST /api/session/update
  if (request.method === "POST" && pathname === "/api/session/update") {
    return handleSessionUpdate(request, env, corsHeaders);
  }

  // POST /api/connect
  if (request.method === "POST" && pathname === "/api/connect") {
    return handleConnect(request, env, corsHeaders);
  }

  // DELETE /api/session/delete
  if (request.method === "DELETE" && pathname === "/api/session/delete") {
    return handleSessionDelete(request, env, corsHeaders);
  }

  // POST /api/temp-key/create
  if (request.method === "POST" && pathname === "/api/temp-key/create") {
    return handleTempKeyCreate(request, env, corsHeaders);
  }

  // GET /api/temp-key/verify
  if (request.method === "GET" && pathname === "/api/temp-key/verify") {
    return handleTempKeyVerify(request, env, corsHeaders);
  }

  // DELETE /api/temp-key/remove
  if (request.method === "DELETE" && pathname === "/api/temp-key/remove") {
    return handleTempKeyRemove(request, env, corsHeaders);
  }

  // POST /api/tunnel/create
  if (request.method === "POST" && pathname === "/api/tunnel/create") {
    return handleTunnelCreate(request, env, corsHeaders);
  }

  // DELETE /api/tunnel/delete
  if (request.method === "DELETE" && pathname === "/api/tunnel/delete") {
    return handleTunnelDelete(request, env, corsHeaders);
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}
