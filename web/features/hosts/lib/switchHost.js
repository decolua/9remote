"use client";

import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS } from "@/shared/constants/API";
import { verifyServerConnection } from "@/shared/hooks/useAuth";
import { saveLastRoute } from "@/shared/hooks/useLastRoute";
import { setAuthData } from "@/shared/hooks/useSessionStorage";
import { headOf } from "@/shared/utils/apiKey";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { WANTS_SAVE_KEY } from "@/shared/constants/transport";

// Supersedes any in-flight switch: two rapid taps race their verifies, and the
// slower one landing LAST would re-key onto the wrong host. Last intent wins.
let switchSeq = 0;

// Core of MenuItems.handleSwitchAgent, shared with the fleet view: verify the
// target host is reachable before leaving the current one, then re-key the
// workspace connection IN PLACE (setAuthData bumps authKey; useBus rebuilds the
// transport without a page reload). Throws on failure.
export async function switchHost(newKey, { currentKey: passedCurrent } = {}) {
  if (typeof window === "undefined") return;
  const seq = ++switchSeq;
  const st = useFleetStore.getState();
  const currentKey = passedCurrent || st.hosts[st.currentKey]?.full || st.currentKey;
  if (currentKey) {
    saveLastRoute(currentKey, window.location.pathname + window.location.search);
    // The host being left was live a second ago — its fleet bus must
    // auto-connect on the far side of the re-key, not show offline from cache.
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
  if (seq !== switchSeq) return; // a newer switch superseded this one

  setAuthData({ apiKey: newKey, tunnelUrl: data.tunnelUrl, mode: "remote", localIp: data.localIp || null });
}

/**
 * Flag that the key the agent is about to issue must be saved.
 *
 * Call BEFORE attempting the pairing connection: the agent hands the key over
 * on the first connect, which can beat a flag set afterwards.
 */
export function armPairingSave(remember) {
  if (typeof window === "undefined") return;
  try {
    if (remember) sessionStorage.setItem(WANTS_SAVE_KEY, "1");
    else sessionStorage.removeItem(WANTS_SAVE_KEY);
  } catch {}
}

// One-time pairing keys cannot join the fleet directly: the agent issues the
// real key (TAIL included) only over an enrollment connection that presents the
// tempKey, so this path logs INTO the host once. One door shared by the login
// page and the in-app add-host modal — WANTS_SAVE_KEY defers the save until the
// agent hands the key over (commitPendingKey → PENDING_SAVE_KEY).
//
// Call AFTER a successful authenticateWithToken. `navigate` is for callers that
// are already inside the workspace: the re-key (setAuthData → authKey) rebuilds
// the connection in place, so a reload would only cost a page load.
export function finishPairingLogin(parsed, { remember = true, leavingHead = null, navigate = true } = {}) {
  if (parsed?.tail && parsed.tempKey) setTrust(parsed.tempKey, { tail: parsed.tail });
  armPairingSave(remember);
  // The workspace host being left (add-host modal) stays a fleet member — its
  // bus must auto-connect on the far side of the re-key, not land offline.
  if (leavingHead) {
    saveLastRoute(leavingHead, window.location.pathname + window.location.search);
    useFleetStore.getState().setAutoConnect(headOf(leavingHead), true);
  }
  if (navigate) window.location.href = "/workspace/";
}
