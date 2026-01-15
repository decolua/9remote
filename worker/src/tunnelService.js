/**
 * Create Cloudflare Tunnel
 * @param {string} accountId
 * @param {string} apiKey - Global API Key
 * @param {string} email - Cloudflare email
 * @returns {Promise<{id: string, token: string}>}
 */
export async function createTunnel(accountId, apiKey, email) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/tunnels`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Email": email,
        "X-Auth-Key": apiKey
      },
      body: JSON.stringify({
        name: `9remote-${Date.now()}`,
        config_src: "cloudflare"
      })
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    throw new Error(`Failed to create tunnel: ${JSON.stringify(data.errors)}`);
  }

  return {
    id: data.result.id,
    token: data.result.token
  };
}

/**
 * Delete Cloudflare Tunnel
 * @param {string} accountId
 * @param {string} apiKey - Global API Key
 * @param {string} email - Cloudflare email
 * @param {string} tunnelId
 */
export async function deleteTunnel(accountId, apiKey, email, tunnelId) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/tunnels/${tunnelId}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Email": email,
        "X-Auth-Key": apiKey
      }
    }
  );

  const data = await response.json();
  
  if (!data.success) {
    console.error(`Failed to delete tunnel ${tunnelId}:`, data.errors);
  }
}

// Remove unused function
// function generateTunnelSecret() {
//   const bytes = new Uint8Array(32);
//   crypto.getRandomValues(bytes);
//   return btoa(String.fromCharCode(...bytes));
// }
