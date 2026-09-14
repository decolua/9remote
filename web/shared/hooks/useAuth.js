import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS, TUNNEL_VERIFY_TIMEOUT_MS, CONNECT_TIMEOUT_MS, LOCAL_AGENT_STATE } from "@/shared/constants/API";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { isLocalAgentNetwork, isLoopbackOrigin, agentOriginFrom } from "@/shared/utils/localOrigin";

// Plain text, not a translation key: this hook has no i18n context, and the
// login page swaps it for the localised string it already owns.
const WRONG_KEY_MESSAGE = "wrong-key-tail";
import { useSessionStorage } from "./useSessionStorage";


// Verify server reachability via HTTP health check (avoids extra WS connection)
export async function verifyServerConnection(tunnelUrl, apiKey, timeout = TUNNEL_VERIFY_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${tunnelUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask the agent whether this TAIL is the right one, before a session is opened.
 *
 * The Worker cannot answer it — it holds only the HEAD — so the question goes
 * straight down the tunnel. Returns true/false when the agent replies, and null
 * when it could not be reached: unreachable is not "wrong", and login carries
 * on to let the connection's own gate decide.
 */
export async function verifyKeyWithAgent(tunnelUrl, { tail, tempKey }, timeout = TUNNEL_VERIFY_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${tunnelUrl}/api/verify-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tail: tail || null, tempKey: tempKey || null }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json())?.ok === true;
  } catch {
    return null; // unreachable — not a verdict
  }
}

/**
 * Which origin the agent answers on, or null when this page is not local.
 * Agent-served pages (loopback/LAN) are their own answer; a dev-server page is
 * loopback but is NOT the agent, so asking its own origin would 404 and silently
 * demote a machine the LAN can reach to the Worker.
 */
async function resolveAgentOrigin() {
  if (!isLoopbackOrigin()) return isLocalAgentNetwork() ? window.location.origin : null;
  return agentOriginFrom(await fetchAgentState());
}

/** The agent's own state payload from this browser, or null when none answers. */
async function fetchAgentState() {
  try {
    const res = await fetch(LOCAL_AGENT_STATE);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Centralized auth logic - handles both token and API key auth
export function useAuth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { setAuth } = useSessionStorage();

  // Generic authenticate function - handles both token and apiKey
  const authenticate = useCallback(async (credentials) => {
    setLoading(true);
    setError("");

    try {
      // Only a page the agent itself serves (loopback/LAN) may receive the
      // TAIL — never an arbitrary origin that happens to host this bundle.
      const agentOrigin = await resolveAgentOrigin();

      if (agentOrigin) {
        const tail = credentials.tail || tailOf(credentials.apiKey || "");
        const tempKey = credentials.tempKey || (credentials.token?.length <= 8 ? credentials.token : null);
        try {
          const directCheck = await verifyKeyWithAgent(agentOrigin, { tail, tempKey });
          if (directCheck === true) {
            const rawKey = credentials.apiKey || tempKey || "";
            const apiKey = headOf(rawKey) || "direct";
            if (tail) setTrust(apiKey, { tail });
            setAuth({
              apiKey,
              tunnelUrl: agentOrigin,
              mode: "local",
              tempKey: tempKey ? tempKey.toUpperCase() : null,
              localIp: null
            });
            return { success: true, shouldAskToSave: true, apiKey };
          } else if (directCheck === false) {
            setError(WRONG_KEY_MESSAGE);
            return { success: false, wrongTail: true };
          }
        } catch {
          // Fall through to remote connect if direct agent check failed
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(API_ENDPOINTS.connect, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...credentials, apiKey: headOf(credentials.apiKey) }),
          signal: controller.signal
        });
      } catch (e) {
        throw new Error(e?.name === "AbortError" ? "Connection timed out. Please try again." : "Network error. Please try again.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Authentication failed");
      }

      const data = await response.json();

      // v2 keys travel as HEAD only — the TAIL never leaves the browser (it
      // is kept in the device-trust store and proven to the agent directly).
      const apiKey = headOf(credentials.apiKey || data.apiKey);

      // The agent registers both host keys when it publishes its session, so
      // the sealing key is available from the very first login — before RTC has
      // ever run. Storing it here is what lets the TAIL be sealed on the first
      // connection instead of crossing the tunnel in the clear, which is
      // exactly the connection where a pairing secret is most exposed.
      //
      // The Worker is not trusted with the tail itself: it holds no X25519
      // private key, so a substituted key produces a seal the real agent cannot
      // open, and the agent answers "seal-unreadable" rather than admitting it.
      if (data.hostKeys?.x) {
        setTrust(apiKey, { hostSealKey: data.hostKeys.x, hostPubKey: data.hostKeys.ed || null });
      }

      // /api/connect proved the Worker knows this HEAD — and that is all it can
      // prove, because the TAIL never reaches it. Ask the agent directly before
      // going any further: a wrong TAIL belongs on the login screen, not in a
      // workspace the user is thrown out of a moment later.
      //
      // Best-effort by design. If the tunnel is down or slow, login proceeds
      // and the connection's own gate decides — that check is the real one, and
      // this is only about telling the user sooner.
      const tail = credentials.tail || tailOf(credentials.apiKey || "");
      if (data.tunnelUrl && (tail || credentials.tempKey)) {
        const verdict = await verifyKeyWithAgent(data.tunnelUrl, {
          tail,
          tempKey: credentials.tempKey || null
        });
        if (verdict === false) {
          // Same message the post-login refusal shows, raised before the user
          // has gone anywhere.
          setError(WRONG_KEY_MESSAGE);
          return { success: false, wrongTail: true };
        }
      }

      // Save auth data to session storage (include tempKey and localIp if provided)
      setAuth({
        apiKey,
        tunnelUrl: data.tunnelUrl,
        mode: "remote",
        tempKey: credentials.tempKey ? credentials.tempKey.toUpperCase() : null,
        localIp: data.localIp || null
      });

      // Return success with flag to ask user about saving key
      return {
        success: true,
        shouldAskToSave: true,
        apiKey
      };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, [router, setAuth]);

  // Token-based auth (QR code) - supports both old token and new temp key
  const authenticateWithToken = useCallback(async (token, isTempKey = false, tail = null) => {
    if (isTempKey) {
      // Temp key: verify first to get API key, then pass tempKey for removal.
      // The tail rides along so the agent can be asked about it before the user
      // is sent anywhere — the Worker never sees it either way.
      return authenticate({ token, tempKey: token, tail });
    }
    return authenticate({ token });
  }, [authenticate]);

  // API key auth
  const authenticateWithApiKey = useCallback(async (apiKey) => {
    return authenticate({ apiKey });
  }, [authenticate]);

  return {
    loading,
    error,
    authenticateWithToken,
    authenticateWithApiKey
  };
}
