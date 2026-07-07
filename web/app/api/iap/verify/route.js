import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { verifyAppleTransaction } from "@/shared/lib/iapApple";
import { verifyGooglePurchase } from "@/shared/lib/iapGoogle";

export function OPTIONS() { return optionsResponse(); }

// POST {accountId, platform, productId, transactionId|receipt, purchaseToken}
// Idempotent: dedup by originalTransactionId (ios) / purchaseToken (android)
export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { accountId, platform, productId, transactionId, receipt, purchaseToken } = await request.json();
    if (!accountId || !platform || !productId) return jsonError("Missing required fields");
    if (!["ios", "android"].includes(platform)) return jsonError("Invalid platform");

    const dedupKey = platform === "ios" ? transactionId : purchaseToken;
    if (!dedupKey) return jsonError("Missing transactionId/purchaseToken");

    // Idempotent: already verified → return current entitlement
    const existing = await env.DB.prepare(
      "SELECT accountId FROM iap_receipts WHERE id = ?"
    ).bind(dedupKey).first();
    if (existing) {
      const ent = await getEntitlement(env, accountId);
      return jsonOk({ verified: true, dedup: true, entitlement: ent });
    }

    // S2S verify
    const result = platform === "ios"
      ? await verifyAppleTransaction(env, { transactionId, receipt, productId })
      : await verifyGooglePurchase(env, { purchaseToken, productId });

    if (!result.verified) {
      await saveReceipt(env, dedupKey, accountId, platform, productId, receipt, "failed");
      return jsonError(result.error || "Verification failed");
    }

    await saveReceipt(env, dedupKey, accountId, platform, productId, receipt, "verified");
    const ent = await upsertEntitlement(env, accountId, productId, result);
    return jsonOk({ verified: true, entitlement: ent });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

async function saveReceipt(env, id, accountId, platform, productId, rawReceipt, status) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO iap_receipts (id, accountId, platform, productId, rawReceipt, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, accountId, platform, productId, rawReceipt || null, status).run();
}

async function upsertEntitlement(env, accountId, productId, result) {
  const plan = productId.includes("yearly") ? "pro_yearly" : "pro_monthly";
  const expiresAt = result.expiresAt || null;
  const originalPurchaseDate = result.originalPurchaseDate || null;
  const status = expiresAt && new Date(expiresAt) < new Date() ? "expired" : "active";
  await env.DB.prepare(
    `INSERT INTO iap_entitlements (accountId, plan, status, expiresAt, originalPurchaseDate, updatedAt)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(accountId) DO UPDATE SET
       plan=excluded.plan, status=excluded.status, expiresAt=excluded.expiresAt,
       originalPurchaseDate=excluded.originalPurchaseDate, updatedAt=CURRENT_TIMESTAMP`
  ).bind(accountId, plan, status, expiresAt, originalPurchaseDate).run();
  return { plan, status, expiresAt };
}

async function getEntitlement(env, accountId) {
  return await env.DB.prepare(
    "SELECT plan, status, expiresAt FROM iap_entitlements WHERE accountId = ?"
  ).bind(accountId).first() || { plan: null, status: "inactive", expiresAt: null };
}
