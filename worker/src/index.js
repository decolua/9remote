import { handleStaticAsset } from "./handlers/static.js";
import { handleSessionCreate, handleSessionUpdate, handleConnect, handleSessionDelete } from "./handlers/session.js";

// CORS headers
const corsHeaders = {
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

  // Scheduled cleanup
  async scheduled(event, env, ctx) {
    try {
      const result = await env.DB.prepare(`
        DELETE FROM sessions WHERE expiresAt < datetime('now')
      `).run();

      console.log(`Cleaned up ${result.meta.changes} expired sessions`);
    } catch (error) {
      console.error("Scheduled cleanup error:", error);
    }
  }
};

/**
 * Handle API routes
 */
async function handleAPI(request, pathname, env) {
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

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}
