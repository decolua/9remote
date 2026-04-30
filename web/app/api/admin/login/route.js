import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse, corsHeaders } from "@/shared/utils/apiResponse";
import { verifyPassword, signAdminToken, buildSetCookie } from "@/features/admin/lib/auth";

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { username, password } = await request.json();
    if (!username || !password) return jsonError("Missing credentials");

    const row = await env.DB.prepare(
      "SELECT id, username, passwordHash, modeId FROM admins WHERE username = ?"
    ).bind(username).first();
    if (!row) return jsonError("Invalid credentials", 401);

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) return jsonError("Invalid credentials", 401);

    await env.DB.prepare("UPDATE admins SET lastLoginAt = datetime('now') WHERE id = ?")
      .bind(row.id).run();

    const token = await signAdminToken(env, { adminId: row.id, username: row.username });
    return new Response(JSON.stringify({ success: true, username: row.username }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Set-Cookie": buildSetCookie(token) }
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
