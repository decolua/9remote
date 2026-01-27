const TUNNEL_DOMAIN = "9router.com";
const ZONE_ID = "04a8428adbeed74b1a9364fcfb0ce145";

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
 * Create Cloudflare Tunnel with public hostname
 * @param {string} accountId
 * @param {string} apiKey - Global API Key
 * @param {string} email - Cloudflare email
 * @param {string} machineId - Machine identifier for tunnel name
 * @returns {Promise<{tunnelId: string, token: string, hostname: string}>}
 */
export async function createTunnel(accountId, apiKey, email, machineId) {
  const tunnelName = `9remote-${machineId}`;
  const publicHostname = `t${machineId}.${TUNNEL_DOMAIN}`;
  
  // Check if tunnel already exists
  const existingTunnel = await getTunnelByName(accountId, apiKey, email, tunnelName);
  if (existingTunnel) {
    // Delete old tunnel first (also deletes DNS record)
    await deleteTunnel(accountId, apiKey, email, existingTunnel.id, machineId);
  }
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`,
    {
      method: "POST",
      headers: buildCfHeaders(apiKey, email),
      body: JSON.stringify({
        name: tunnelName,
        config_src: "cloudflare"
      })
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    throw new Error(`Failed to create tunnel: ${JSON.stringify(data.errors)}`);
  }

  const tunnelId = data.result.id;
  
  // Create or update DNS CNAME record (reuse if exists - no spam)
  await upsertDnsRecord(apiKey, email, machineId, tunnelId);
  
  // Configure tunnel ingress with public hostname
  await configureTunnelIngress(accountId, apiKey, email, tunnelId, publicHostname);

  return {
    tunnelId,
    token: data.result.token,
    hostname: `https://${publicHostname}`
  };
}

/**
 * Get tunnel by name
 */
async function getTunnelByName(accountId, apiKey, email, tunnelName) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?name=${tunnelName}`,
    {
      method: "GET",
      headers: buildCfHeaders(apiKey, email)
    }
  );

  const data = await response.json();
  
  if (data.success && data.result && data.result.length > 0) {
    return data.result[0];
  }
  
  return null;
}

/**
 * Find DNS record by machineId
 */
async function findDnsRecord(apiKey, email, machineId) {
  const fullDnsName = `t${machineId}.${TUNNEL_DOMAIN}`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=CNAME&name=${fullDnsName}`,
    {
      method: "GET",
      headers: buildCfHeaders(apiKey, email)
    }
  );

  const data = await response.json();
  
  if (data.success && data.result && data.result.length > 0) {
    return data.result[0];
  }
  
  return null;
}

/**
 * Create or update DNS CNAME record pointing to tunnel
 * Reuses existing record if found (no spam)
 */
async function upsertDnsRecord(apiKey, email, machineId, tunnelId) {
  const cnameTarget = `${tunnelId}.cfargotunnel.com`;
  const existingRecord = await findDnsRecord(apiKey, email, machineId);
  
  if (existingRecord) {
    // Update existing record (no new CNAME created)
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${existingRecord.id}`,
      {
        method: "PATCH",
        headers: buildCfHeaders(apiKey, email),
        body: JSON.stringify({
          content: cnameTarget
        })
      }
    );
    
    const data = await response.json();
    if (!data.success) {
      console.error("Failed to update DNS record:", data.errors);
    }
    return existingRecord.id;
  }
  
  // Create new record only if not exists
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`,
    {
      method: "POST",
      headers: buildCfHeaders(apiKey, email),
      body: JSON.stringify({
        type: "CNAME",
        name: `t${machineId}`,
        content: cnameTarget,
        proxied: true
      })
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    // Ignore duplicate record errors
    if (!JSON.stringify(data.errors).includes("already exists")) {
      console.error("Failed to create DNS record:", data.errors);
    }
  }
  
  return data.result?.id;
}

/**
 * Delete DNS CNAME record
 */
async function deleteDnsRecord(apiKey, email, machineId) {
  const existingRecord = await findDnsRecord(apiKey, email, machineId);
  
  if (existingRecord) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${existingRecord.id}`,
      {
        method: "DELETE",
        headers: buildCfHeaders(apiKey, email)
      }
    );
  }
}

/**
 * Configure tunnel ingress rules with public hostname
 */
async function configureTunnelIngress(accountId, apiKey, email, tunnelId, publicHostname) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      headers: buildCfHeaders(apiKey, email),
      body: JSON.stringify({
        config: {
          ingress: [
            { 
              hostname: publicHostname,
              service: "http://localhost:2208"
            },
            { service: "http_status:404" }
          ]
        }
      })
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    console.error("Failed to configure tunnel ingress:", data.errors);
  }
}

/**
 * Delete Cloudflare Tunnel and its DNS record
 * @param {string} accountId
 * @param {string} apiKey - Global API Key
 * @param {string} email - Cloudflare email
 * @param {string} tunnelId
 * @param {string} machineId - For DNS cleanup
 */
export async function deleteTunnel(accountId, apiKey, email, tunnelId, machineId) {
  // Delete DNS record first
  if (machineId) {
    await deleteDnsRecord(apiKey, email, machineId);
  }
  
  // Force cleanup connections
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
    {
      method: "DELETE",
      headers: buildCfHeaders(apiKey, email)
    }
  );
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    {
      method: "DELETE",
      headers: buildCfHeaders(apiKey, email)
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    console.error(`Failed to delete tunnel ${tunnelId}:`, data.errors);
  }
}

/**
 * List tunnels by status
 */
async function listTunnelsByStatus(accountId, apiKey, email, status) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false&status=${status}`,
    {
      method: "GET",
      headers: buildCfHeaders(apiKey, email)
    }
  );

  const data = await response.json();
  return data.success ? data.result : [];
}

/**
 * Cleanup dead tunnels (down/inactive/degraded)
 * Called by scheduled job
 */
export async function cleanupDeadTunnels(accountId, apiKey, email) {
  const statuses = ["down", "inactive", "degraded"];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  let cleanedCount = 0;
  
  for (const status of statuses) {
    const tunnels = await listTunnelsByStatus(accountId, apiKey, email, status);
    
    for (const tunnel of tunnels) {
      // Only cleanup 9remote tunnels
      if (!tunnel.name.startsWith("9remote-")) continue;
      
      // Get last connection closed time
      let lastClosedAt = null;
      if (tunnel.connections && tunnel.connections.length > 0) {
        const closedConnections = tunnel.connections
          .filter(c => c.closed_at)
          .map(c => new Date(c.closed_at));
        
        if (closedConnections.length > 0) {
          lastClosedAt = new Date(Math.max(...closedConnections));
        }
      }
      
      // Use closed_at if available, otherwise use created_at
      const checkTime = lastClosedAt || new Date(tunnel.created_at);
      
      // Only delete if disconnected for more than 1 hour
      if (checkTime > oneHourAgo) {
        console.log(`[Cleanup] Skip ${tunnel.name} - disconnected < 1 hour`);
        continue;
      }
      
      // Extract machineId from tunnel name
      const machineId = tunnel.name.replace("9remote-", "");
      
      console.log(`[Cleanup] Dead tunnel: ${tunnel.name} (${tunnel.status})`);
      
      try {
        await deleteTunnel(accountId, apiKey, email, tunnel.id, machineId);
        cleanedCount++;
      } catch (error) {
        console.error(`[Cleanup] Failed to delete ${tunnel.name}:`, error);
      }
    }
  }
  
  return cleanedCount;
}
