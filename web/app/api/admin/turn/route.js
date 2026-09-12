import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { TURN_SCOPES, generateIceServers, tailOfSecret } from "@/features/admin/lib/turnKeys";

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.turnView);
    if (error) return error;
    const { results } = await env.DB.prepare(
      "SELECT id, keyId, secret, label, scope, enabled, lastUsedAt, createdAt FROM turnKeys ORDER BY createdAt ASC"
    ).all();
    // Secrets are write-only from here on — the list carries a hint, never the value.
    const items = (results || []).map(({ secret, ...rest }) => ({ ...rest, secretTail: tailOfSecret(secret) }));
    return jsonOk({ items });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

export async function POST(request) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.turnManage);
    if (error) return error;
    const { keyId, secret, label, scope } = await request.json();
    if (!keyId || !secret) return jsonError("Missing keyId or secret");
    if (scope && !TURN_SCOPES.includes(scope)) return jsonError("Invalid scope");

    // Validate against Cloudflare before storing: a typo'd key would otherwise
    // only surface later as relay silently missing for every client.
    const check = await generateIceServers({ keyId, secret, ttl: 3600 });
    if (check.error) return jsonError(`Cloudflare rejected the key: ${check.error}`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // New keys start stale on purpose: they join the rotation at the back of the
    // queue instead of yanking traffic off the key that is currently serving.
    await env.DB.prepare(
      "INSERT INTO turnKeys (id, keyId, secret, label, scope, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, keyId, secret, label || "", scope || "both", now).run();
    return jsonOk({ success: true, id });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
