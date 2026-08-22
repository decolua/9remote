import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS, TUNNEL_VERIFY_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from "@/shared/constants/API";
import { headOf } from "@/shared/utils/apiKey";
import { pinHostKeysWithFp2 } from "@/shared/transport/lib/deviceTrust";
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

      // Anchor the agent's host keys while the pairing fp2 is still in hand.
      // They came from the Worker, which is not trusted for this — fp2 over the
      // pair is checked against what the user read off the agent's screen. A
      // client that pairs but never gets RTC up would otherwise have nothing to
      // seal its tail to, and that is exactly the client on the tunnel.
      if (data.hostKeys) await pinHostKeysWithFp2(apiKey, data.hostKeys);

      // /api/connect already validated the apiKey/session — agent is alive.
      // Tunnel liveness is no longer probed here: RTC is established via the DO
      // signaling relay (independent of the tunnel), and the tunnel is a fallback
      // transport that ProtocolManager brings up in parallel.

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
  const authenticateWithToken = useCallback(async (token, isTempKey = false) => {
    if (isTempKey) {
      // Temp key: verify first to get API key, then pass tempKey for removal
      return authenticate({ token, tempKey: token });
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
