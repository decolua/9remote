import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, jsonRateLimited, optionsResponse, corsHeaders } from "@/shared/utils/apiResponse";
import { withD1Retry } from "@/shared/utils/db";
import { RATE_LIMITS, clientIp, isRateLimited, recordFailure, clearFailures } from "@/shared/utils/rateLimit";
import { verifyPassword, signAdminToken, buildSetCookie } from "@/features/admin/lib/auth";
import { checkLoginGuard, recordLoginFailure, clearLoginFailures, logLoginAttempt, delayMsFor } from "@/features/admin/lib/loginGuard";
import { verifyTurnstile } from "@/features/admin/lib/turnstile";

const SCOPE = "adminLogin";

export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const ip = clientIp(request);
    // Cheap layers first: in-memory block list (no I/O), then the durable D1
    // lockout — a locked client must not be able to spend Turnstile quota,
    // bcrypt or lookup rounds.
    if (isRateLimited(SCOPE, ip, RATE_LIMITS.adminLogin)) {
      return jsonRateLimited(RATE_LIMITS.adminLogin.windowSec);
    }

    const { username, password, turnstileToken } = await request.json();
    if (!username || !password) return jsonError("Missing credentials");

    const guard = await checkLoginGuard(env, ip, username);
    if (guard.locked) {
      await logLoginAttempt(env, { username, ip, ok: false, reason: "locked" });
      return jsonRateLimited(guard.retryAfterSec);
    }

    // Bot gate before any expensive work. Counts as a failure so scanners burn
    // their budget on the cheap path.
    if (!(await verifyTurnstile(env, turnstileToken, ip))) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.adminLogin, env.LOGIN_RATE_LIMITER);
      await logLoginAttempt(env, { username, ip, ok: false, reason: "turnstile" });
      return jsonError("Captcha verification failed", 403);
    }

    // Account-wide delay. Applies to this attempt regardless of outcome —
    // otherwise a correct guess could be identified by answering instantly.
    const delayMs = delayMsFor(guard.userFails);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT id, username, passwordHash, modeId FROM admins WHERE username = ?"
    ).bind(username).first());
    // Unknown user and wrong password fail identically — no user enumeration.
    if (!row) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.adminLogin, env.LOGIN_RATE_LIMITER);
      await recordLoginFailure(env, ip, username);
      await logLoginAttempt(env, { username, ip, ok: false, reason: "unknownUser" });
      return jsonError("Invalid credentials", 401);
    }

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      await recordFailure(SCOPE, ip, RATE_LIMITS.adminLogin, env.LOGIN_RATE_LIMITER);
      await recordLoginFailure(env, ip, username);
      await logLoginAttempt(env, { username, ip, ok: false, reason: "badPassword" });
      return jsonError("Invalid credentials", 401);
    }

    // Correct password wipes the slate: a few typos before a successful login
    // leave no trace for the rest of the window.
    clearFailures(SCOPE, ip);
    await clearLoginFailures(env, ip, username);
    await logLoginAttempt(env, { username, ip, ok: true, reason: "ok" });

    await withD1Retry(() => env.DB.prepare("UPDATE admins SET lastLoginAt = datetime('now') WHERE id = ?")
      .bind(row.id).run());

    const token = await signAdminToken(env, { adminId: row.id, username: row.username });
    return new Response(JSON.stringify({ success: true, username: row.username }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Set-Cookie": buildSetCookie(token, request) }
    });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
