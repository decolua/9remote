import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS } from "@/shared/constants/API";
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

      // Verify WebSocket connection before saving auth
      const resolvedApiKey = credentials.apiKey || data.apiKey;
      const connected = await verifyServerConnection(data.tunnelUrl, resolvedApiKey);
      if (!connected) {
        throw new Error("Server not reachable. Please try again.");
      }

      // Save auth data to session storage (include tempKey and localIp if provided)
      setAuth({
        apiKey: credentials.apiKey || data.apiKey,
        tunnelUrl: data.tunnelUrl,
        mode: "remote",
        tempKey: credentials.tempKey || null,
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
