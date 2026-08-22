import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseApiKey, verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { withD1Retry, invalidateCache, cacheKeys } from "@/shared/utils/db";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { canReplaceHostKey } from "@/shared/utils/sessionMutationAuth";


export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
  const { env } = getCloudflareContext();
  const { apiKey, hostPublicKey, hostX25519Key, tempKey } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey, env))) return jsonError("Invalid API key");
  const { machineId } = parseApiKey(apiKey);

  // A registered host key is what stops anyone holding the HEAD from repointing
  // this session, so it must not be replaceable by simply sending another one.
  // A reinstalled agent does need a way back: a live pairing code, read off its
  // own screen, is the claim only someone at that machine can make.
  const existing = await withD1Retry(() => env.DB.prepare(
    "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
  ).bind(apiKey).first());

  let pairedNow = false;
  if (existing?.hostPublicKey && hostPublicKey && existing.hostPublicKey !== hostPublicKey && tempKey) {
    // expires_at is epoch milliseconds here, not a datetime string — temp-key
    // create binds Date.now() + minutes, and verify compares it as a number.
    // datetime('now') would compare an integer against text, which in SQLite
    // makes the integer always smaller, so nothing would ever match.
    const paired = await withD1Retry(() => env.DB.prepare(
      "SELECT 1 AS ok FROM temp_keys WHERE temp_key = ? AND api_key = ? AND expires_at > ?"
    ).bind(String(tempKey).toUpperCase(), apiKey, Date.now()).first());
    pairedNow = !!paired;
  }

  // Both halves move together or neither does: fp2 is one fingerprint over the
  // pair, so a row holding one agent's signing key and another's sealing key
  // would match no fingerprint at all.
  const accepted = canReplaceHostKey({
    stored: existing?.hostPublicKey || null,
    presented: hostPublicKey || null,
    pairedNow
  });
  const keyToWrite = accepted ? (hostPublicKey || null) : existing.hostPublicKey;
  const sealKeyToWrite = accepted ? (hostX25519Key || null) : null;

  await withD1Retry(() => env.DB.prepare(`
    INSERT INTO sessions (machineId, apiKey, hostPublicKey, hostX25519Key, tunnelUrl, lastAccessAt, expiresAt)
    VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now', '+7 days'))
    ON CONFLICT(apiKey)
    DO UPDATE SET
      -- COALESCE keeps a registered key when this call carries none (an older
      -- agent, or one that failed to read hostKey.json).
      hostPublicKey = COALESCE(excluded.hostPublicKey, sessions.hostPublicKey),
      hostX25519Key = COALESCE(excluded.hostX25519Key, sessions.hostX25519Key),
      lastAccessAt = datetime('now'),
      expiresAt = datetime('now', '+7 days')
  `).bind(machineId, apiKey, keyToWrite, sealKeyToWrite).run());

  // A restart reuses the apiKey but drops the old tunnelUrl — clear the cache so
  // clients do not keep resolving to the previous run's tunnel.
  invalidateCache(cacheKeys.tunnel(apiKey));

  return jsonOk({ success: true, machineId });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
