import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

// GET ?deviceId=&platform= → lookup accountId (or 404)
export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId");
    const platform = url.searchParams.get("platform");
    if (!deviceId || !platform) return jsonError("Missing deviceId or platform");

    const link = await env.DB.prepare(
      "SELECT accountId FROM iap_device_links WHERE deviceId = ? AND platform = ?"
    ).bind(deviceId, platform).first();
    if (!link) return jsonError("Account not found", 404);

    return jsonOk({ accountId: link.accountId });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

// POST {deviceId, platform, providerAccount?} → create or merge account
// providerAccount = originalTransactionId (ios) | purchaseToken (android) for restore merge
export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { deviceId, platform, providerAccount } = await request.json();
    if (!deviceId || !platform) return jsonError("Missing deviceId or platform");
    if (!["ios", "android", "web"].includes(platform)) return jsonError("Invalid platform");

    // 1. Existing link for this device
    const existing = await env.DB.prepare(
      "SELECT accountId FROM iap_device_links WHERE deviceId = ? AND platform = ?"
    ).bind(deviceId, platform).first();
    if (existing) {
      await linkDevice(env, existing.accountId, deviceId, platform);
      return jsonOk({ accountId: existing.accountId });
    }

    // 2. Restore: providerAccount → find prior account that verified this receipt
    if (providerAccount) {
      const prior = await env.DB.prepare(
        "SELECT accountId FROM iap_receipts WHERE id = ?"
      ).bind(providerAccount).first();
      if (prior) {
        await linkDevice(env, prior.accountId, deviceId, platform);
        return jsonOk({ accountId: prior.accountId, restored: true });
      }
    }

    // 3. New account
    const accountId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO iap_accounts (id) VALUES (?)").bind(accountId).run();
    await linkDevice(env, accountId, deviceId, platform);
    return jsonOk({ accountId, created: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

async function linkDevice(env, accountId, deviceId, platform) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO iap_device_links (accountId, deviceId, platform) VALUES (?, ?, ?)"
  ).bind(accountId, deviceId, platform).run();
}
