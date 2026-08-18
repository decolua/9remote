import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, jsonRateLimited, optionsResponse, corsHeaders } from "@/shared/utils/apiResponse";
import { withD1Retry } from "@/shared/utils/db";
import { RATE_LIMITS, clientIp, isRateLimited, recordFailure, clearFailures } from "@/shared/utils/rateLimit";
import { verifyPassword, signAdminToken, buildSetCookie } from "@/features/admin/lib/auth";

const SCOPE = "adminLogin";

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const ip = clientIp(request);
    // Checked before parsing or hashing: bcrypt is the expensive part, and a
    // blocked client must not be able to spend it.
    if (isRateLimited(SCOPE, ip, RATE_LIMITS.adminLogin)) {
      return jsonRateLimited(RATE_LIMITS.adminLogin.windowSec);
    }

    const { username, password } = await request.json();
    if (!username || !password) return jsonError("Missing credentials");

    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT id, username, passwordHash, modeId FROM admins WHERE username = ?"
    ).bind(username).first());
    // Unknown user and wrong password fail identically — no user enumeration.
    if (!row) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.adminLogin, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid credentials", 401);
    }

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.adminLogin, env.LOGIN_RATE_LIMITER);
      return jsonError("Invalid credentials", 401);
    }

    // Correct password wipes the slate: a few typos before a successful login
    // leave no trace for the rest of the window.
    clearFailures(SCOPE, ip);

    await withD1Retry(() => env.DB.prepare("UPDATE admins SET lastLoginAt = datetime('now') WHERE id = ?")
      .bind(row.id).run());

    const token = await signAdminToken(env, { adminId: row.id, username: row.username });
    return new Response(JSON.stringify({ success: true, username: row.username }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Set-Cookie": buildSetCookie(token) }
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
