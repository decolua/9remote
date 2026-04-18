import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS } from "@/shared/constants/API";
import { useSessionStorage } from "./useSessionStorage";


// Verify server reachability via HTTP health check (avoids extra WS connection)
async function verifyServerConnection(tunnelUrl, apiKey, timeout = 10000) {
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
      const response = await fetch(API_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Authentication failed");
      }

      const data = await response.json();

      // Verify tunnel reachability, retry if not ready (agent may still be starting)
      const resolvedApiKey = credentials.apiKey || data.apiKey;
      let connected = false;
      for (let i = 0; i < TUNNEL_VERIFY_RETRY_MAX; i++) {
        connected = await verifyServerConnection(data.tunnelUrl, resolvedApiKey);
        if (connected) break;
        if (i < TUNNEL_VERIFY_RETRY_MAX - 1) {
          await new Promise((r) => setTimeout(r, TUNNEL_VERIFY_RETRY_INTERVAL_MS));
        }
      }
      if (!connected) {
        throw new Error("Server not reachable. Please try again.");
      }

      // Save auth data to session storage (include tempKey and localIp if provided)
      setAuth({
        apiKey: credentials.apiKey || data.apiKey,
        tunnelUrl: data.tunnelUrl,
        mode: "remote",
        tempKey: credentials.tempKey ? credentials.tempKey.toUpperCase() : null,
        localIp: data.localIp || null
      });

      // Return success with flag to ask user about saving key
      return { 
        success: true, 
        shouldAskToSave: true,
        apiKey: credentials.apiKey || data.apiKey 
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
