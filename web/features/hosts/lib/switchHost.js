"use client";

import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS } from "@/shared/constants/API";
import { verifyServerConnection } from "@/shared/hooks/useAuth";
import { saveLastRoute, getLastRoute } from "@/shared/hooks/useLastRoute";
import { setAuthData } from "@/shared/hooks/useSessionStorage";

// Core of MenuItems.handleSwitchAgent, shared with the fleet view: verify the
// target host is reachable before leaving the current one, then re-auth and
// reload into `route` (or the host's own last route). Throws on failure.
export async function switchHost(newKey, { route, currentKey } = {}) {
  if (typeof window === "undefined") return;
  if (currentKey) saveLastRoute(currentKey, window.location.pathname + window.location.search);

  const resp = await fetch(API_ENDPOINTS.connect, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: newKey })
  });
  if (!resp.ok) throw new Error("connect failed");
  const data = await resp.json();

  let connected = false;
  for (let i = 0; i < TUNNEL_VERIFY_RETRY_MAX && !connected; i++) {
    connected = await verifyServerConnection(data.tunnelUrl, newKey);
    if (!connected && i < TUNNEL_VERIFY_RETRY_MAX - 1) {
      await new Promise((r) => setTimeout(r, TUNNEL_VERIFY_RETRY_INTERVAL_MS));
    }
  }
  if (!connected) throw new Error("unreachable");

  setAuthData({ apiKey: newKey, tunnelUrl: data.tunnelUrl, mode: "remote", localIp: data.localIp || null });
  window.location.href = route || getLastRoute(newKey) || "/workspace/";
}
