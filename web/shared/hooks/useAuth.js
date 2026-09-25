import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS, TUNNEL_VERIFY_TIMEOUT_MS, CONNECT_TIMEOUT_MS, LOCAL_AGENT_STATE } from "@/shared/constants/API";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { isLocalAgentNetwork, isLoopbackOrigin, agentOriginFrom } from "@/shared/utils/localOrigin";

// Marker string localized by the login page.
const WRONG_KEY_MESSAGE = "wrong-key-tail";
import { useSessionStorage } from "./useSessionStorage";

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

// Pre-verify TAIL with agent over tunnel; returns null if unreachable.
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
    return null;
  }
}

// Resolve origin where agent answers, or null if remote.
async function resolveAgentOrigin() {
  if (!isLoopbackOrigin()) return isLocalAgentNetwork() ? window.location.origin : null;
  return agentOriginFrom(await fetchAgentState());
}

async function fetchAgentState() {
  try {
    const res = await fetch(LOCAL_AGENT_STATE);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { setAuth } = useSessionStorage();

  const authenticate = useCallback(async (credentials, { persistSession = true } = {}) => {
    setLoading(true);
    setError("");

    try {
      const agentOrigin = await resolveAgentOrigin();

      if (agentOrigin) {
        const tail = credentials.tail || tailOf(credentials.apiKey || "");
        const tempKey = credentials.tempKey || (credentials.token?.length <= 8 ? credentials.token : null);
        // A local agent can only speak for ITS OWN credentials: another machine's
        // key or pairing code must not be judged by this agent, or every remote
        // one fails as "wrong tail" before the server is ever asked.
        const state = await fetchAgentState();
        const localHead = headOf(state?.permanentKey || "");
        const keyHead = headOf(credentials.apiKey || credentials.token || "");
        // A pairing code belongs to this agent only when its live code IS that code.
        const localCode = String(state?.oneTimeKey || "").slice(0, 6).toUpperCase();
        const speaksForThisKey = tempKey
          ? !!localCode && localCode === tempKey.toUpperCase()
          : (!!localHead && !!keyHead && headOf(localHead) === keyHead);
        try {
          const directCheck = speaksForThisKey ? await verifyKeyWithAgent(agentOrigin, { tail, tempKey }) : null;
          if (directCheck === true) {
            const rawKey = credentials.apiKey || tempKey || "";
            const apiKey = headOf(rawKey) || "direct";
            if (tail) setTrust(apiKey, { tail });
            if (persistSession) {
              setAuth({
                apiKey,
                tunnelUrl: agentOrigin,
                mode: "local",
                tempKey: tempKey ? tempKey.toUpperCase() : null,
                localIp: null
              });
            }
            return { success: true, shouldAskToSave: true, apiKey };
          } else if (directCheck === false) {
            setError(WRONG_KEY_MESSAGE);
            return { success: false, wrongTail: true };
          }
        } catch {
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

      const apiKey = headOf(credentials.apiKey || data.apiKey);

      // Store agent public/seal keys from session for E2E encryption.
      if (data.hostKeys?.x) {
        setTrust(apiKey, { hostSealKey: data.hostKeys.x, hostPubKey: data.hostKeys.ed || null });
      }

      // Best-effort TAIL pre-verification directly against agent.
      const tail = credentials.tail || tailOf(credentials.apiKey || "");
      if (data.tunnelUrl && (tail || credentials.tempKey)) {
        const verdict = await verifyKeyWithAgent(data.tunnelUrl, {
          tail,
          tempKey: credentials.tempKey || null
        });
        if (verdict === false) {
          setError(WRONG_KEY_MESSAGE);
          return { success: false, wrongTail: true };
        }
      }

      if (persistSession) {
        setAuth({
          apiKey,
          tunnelUrl: data.tunnelUrl || null,
          mode: "remote",
          tempKey: credentials.tempKey ? credentials.tempKey.toUpperCase() : null,
          localIp: data.localIp || null
        });
      }

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

  const authenticateWithToken = useCallback(async (token, isTempKey = false, tail = null, opts) => {
    if (isTempKey) {
      return authenticate({ token, tempKey: token, tail }, opts);
    }
    return authenticate({ token }, opts);
  }, [authenticate]);

  const authenticateWithApiKey = useCallback((apiKey, opts) => {
    return authenticate({ apiKey }, opts);
  }, [authenticate]);

  return {
    loading,
    error,
    setError,
    authenticateWithToken,
    authenticateWithApiKey
  };
}
