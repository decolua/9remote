// Server-side Turnstile verification for admin login.
//
// Skipped entirely when TURNSTILE_SECRET_KEY is unset, so dev and undeployed
// environments keep working; production configures it via secrets:sync. Fails
// CLOSED on verifier errors — an unreachable checker must not become an open gate.

export async function verifyTurnstile(env, token, ip) {
  const secret = env?.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token || typeof token !== "string") return false;

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body
    });
    const data = await res.json();
    return data?.success === true;
  } catch {
    return false;
  }
}
