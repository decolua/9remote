import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { API_ENDPOINTS } from "@/shared/constants/api";
import { useSessionStorage } from "./useSessionStorage";

// Verify WebSocket connection to server
function verifyServerConnection(tunnelUrl, timeout = 10000) {
  return new Promise((resolve) => {
    const socket = io(tunnelUrl, {
      path: "/socket.io",
      transports: ["polling", "websocket"],
      timeout: timeout
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      resolve(false);
    }, timeout);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(true);
    });

    socket.on("connect_error", () => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(false);
    });
  });
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
      const connected = await verifyServerConnection(data.tunnelUrl);
      if (!connected) {
        throw new Error("Server not reachable. Please try again.");
      }

      // Save auth data to session storage
      setAuth({
        apiKey: credentials.apiKey || data.apiKey,
        tunnelUrl: data.tunnelUrl,
        mode: "remote"
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

  // Token-based auth (QR code)
  const authenticateWithToken = useCallback(async (token) => {
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
