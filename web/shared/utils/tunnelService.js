// Named tunnels (t-<shortId>.9remote.cc) are gone — the host runs a quick
// tunnel and pushes its URL through session/update. What remains here tears
// down the named tunnels still sitting on the account from that era.
const TUNNEL_DOMAIN = "9remote.cc";
const ZONE_ID = "34ed092484851b44d0ede479b0288738";

/**
 * Build Cloudflare API headers
 */
function buildCfHeaders(apiKey, email) {
  return {
    "Content-Type": "application/json",
    "X-Auth-Email": email,
    "X-Auth-Key": apiKey
  };
}

/**
 * Delete DNS CNAME record
 */
async function deleteDnsRecord(apiKey, email, shortId) {
  const findRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=CNAME&name=t-${shortId}.${TUNNEL_DOMAIN}`,
    { method: "GET", headers: buildCfHeaders(apiKey, email) }
  );
  const findData = await findRes.json();
  const existing = findData.success && findData.result?.length > 0 ? findData.result[0] : null;

  if (existing) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${existing.id}`,
      { method: "DELETE", headers: buildCfHeaders(apiKey, email) }
    );
  }
}

/**
 * Delete Cloudflare Named Tunnel + DNS record
 */
export async function deleteTunnel(accountId, apiKey, email, tunnelId, shortId) {
  if (shortId) {
    await deleteDnsRecord(apiKey, email, shortId);
  }

  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
    { method: "DELETE", headers: buildCfHeaders(apiKey, email) }
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    { method: "DELETE", headers: buildCfHeaders(apiKey, email) }
  );
  const data = await response.json();
  if (!data.success) {
    console.error(`[Tunnel] Failed to delete ${tunnelId}:`, data.errors);
  }
}

/**
 * Cleanup dead tunnels — called by scheduled job
 */
export async function cleanupDeadTunnels(accountId, apiKey, email) {
  const statuses = ["down", "inactive", "degraded"];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  let cleanedCount = 0;

  for (const status of statuses) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false&status=${status}`,
      { method: "GET", headers: buildCfHeaders(apiKey, email) }
    );
    const data = await response.json();
    const tunnels = data.success ? data.result : [];

    for (const tunnel of tunnels) {
      if (!tunnel.name.startsWith("9remote-")) continue;

      const closedTimes = (tunnel.connections || [])
        .filter(c => c.closed_at)
        .map(c => new Date(c.closed_at));

      const checkTime = closedTimes.length > 0
        ? new Date(Math.max(...closedTimes))
        : new Date(tunnel.created_at);

      if (checkTime > oneHourAgo) continue;

      // Extract shortId from tunnel name: 9remote-{shortId}
      const shortId = tunnel.name.replace("9remote-", "");

      console.log(`[Cleanup] Dead tunnel: ${tunnel.name} (${tunnel.status})`);
      try {
        await deleteTunnel(accountId, apiKey, email, tunnel.id, shortId);
        cleanedCount++;
      } catch (error) {
        console.error(`[Cleanup] Failed to delete ${tunnel.name}:`, error);
      }
    }
  }

  return cleanedCount;
}
