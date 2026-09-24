"use client";

import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS } from "@/shared/constants/API";
import { verifyServerConnection } from "@/shared/hooks/useAuth";
import { saveLastRoute, getLastRoute } from "@/shared/hooks/useLastRoute";
import { setAuthData } from "@/shared/hooks/useSessionStorage";
import { headOf } from "@/shared/utils/apiKey";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { WANTS_SAVE_KEY } from "@/shared/constants/transport";

// Core of MenuItems.handleSwitchAgent, shared with the fleet view: verify the
// target host is reachable before leaving the current one, then re-auth and
// reload into `route` (or the host's own last route). Throws on failure.
export async function switchHost(newKey, { route, currentKey } = {}) {
  if (typeof window === "undefined") return;
  if (currentKey) {
    saveLastRoute(currentKey, window.location.pathname + window.location.search);
    // The host being left was live a second ago — its fleet bus must
    // auto-connect on the far side of the reload, not show offline from cache.
    useFleetStore.getState().setAutoConnect(headOf(currentKey), true);
  }

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

// One-time pairing keys cannot join the fleet directly: the agent issues the
// real key (TAIL included) only over an enrollment connection that presents the
// tempKey, so this path logs INTO the host once. One door shared by the login
// page and the in-app add-host modal — WANTS_SAVE_KEY defers the save until the
// agent hands the key over (commitPendingKey → PENDING_SAVE_KEY).
// Call AFTER a successful authenticateWithToken; navigates away itself.
export function finishPairingLogin(parsed, { remember = true, leavingHead = null } = {}) {
  if (parsed?.tail && parsed.tempKey) setTrust(parsed.tempKey, { tail: parsed.tail });
  if (remember) {
    try { sessionStorage.setItem(WANTS_SAVE_KEY, "1"); } catch {}
  }
  // The workspace host being left (add-host modal) stays a fleet member — its
  // bus must auto-connect after the reload instead of landing offline.
  if (leavingHead) useFleetStore.getState().setAutoConnect(headOf(leavingHead), true);
  window.location.href = "/workspace/";
}
