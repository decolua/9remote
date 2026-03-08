"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { useSessionStorage } from "./useSessionStorage";

const RETRY_CONFIG = {
  initialDelay: 5000,  // 5s delay before first retry
  interval: 10000,     // 10s between retries
  maxAttempts: 10      // max 10 retries
};

const DEFAULT_SOCKET_OPTIONS = {
  transports: ["websocket"],  // WebSocket only - polling not supported via Cloudflare Proxy
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
};

/**
 * Base socket hook with tunnel retry logic
 * When socket disconnects and can't reconnect after 10s,
 * it will fetch new tunnel URL using API key
 */
export function useBaseSocket(config = {}) {
  const {
    namespace = "",
    socketOptions = {},
    redirectOnNoAuth = "/",
    onConnect,
    onDisconnect
  } = config;

  const router = useRouter();
  const { getAuth, setAuth } = useSessionStorage();
  
  const socketRef = useRef(null);
  const retryTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const retryScheduledRef = useRef(false); // Prevent duplicate scheduling
  
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [retryStatus, setRetryStatus] = useState({
    isRetrying: false,
    attempt: 0,
    maxAttempts: RETRY_CONFIG.maxAttempts,
    failed: false
  });

  // Fetch new tunnel URL using API key
  const fetchNewTunnelUrl = useCallback(async (apiKey) => {
    try {
      const response = await fetch(API_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey })
      });

      if (!response.ok) {
        throw new Error("Failed to get new tunnel");
      }

      const data = await response.json();
      return data.tunnelUrl;
    } catch {
      return null;
    }
  }, []);

  // Create socket with given URL
  const createSocket = useCallback((tunnelUrl, auth) => {
    const url = namespace ? `${tunnelUrl}${namespace}` : tunnelUrl;
    
    return io(url, {
      ...DEFAULT_SOCKET_OPTIONS,
      ...socketOptions,
      path: "/socket.io"
    });
  }, [namespace, socketOptions]);

  // Cancel retry
  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryAttemptRef.current = 0;
    retryScheduledRef.current = false;
    setRetryStatus({ isRetrying: false, attempt: 0, maxAttempts: RETRY_CONFIG.maxAttempts, failed: false });
  }, []);

  // Setup socket event handlers - defined before startRetry to avoid circular dependency
  const setupSocketHandlersRef = useRef(null);

  // Handle retry with API key
  const startRetry = useCallback(async () => {
    const auth = getAuth();
    
    if (!auth?.apiKey) {
      retryScheduledRef.current = false;
      setRetryStatus(prev => ({ ...prev, isRetrying: false, failed: true }));
      return;
    }

    retryAttemptRef.current += 1;
    const attempt = retryAttemptRef.current;

    if (attempt > RETRY_CONFIG.maxAttempts) {
      retryScheduledRef.current = false;
      setRetryStatus({ isRetrying: false, attempt, maxAttempts: RETRY_CONFIG.maxAttempts, failed: true });
      return;
    }

    setRetryStatus({ isRetrying: true, attempt, maxAttempts: RETRY_CONFIG.maxAttempts, failed: false });

    const newTunnelUrl = await fetchNewTunnelUrl(auth.apiKey);
    
    if (newTunnelUrl) {
      // Update session storage with new tunnel URL
      setAuth({ ...auth, tunnelUrl: newTunnelUrl });

      // Disconnect old socket
      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      // Create new socket with new URL
      const newSocket = createSocket(newTunnelUrl, auth);
      if (setupSocketHandlersRef.current) {
        setupSocketHandlersRef.current(newSocket, auth);
      }
      socketRef.current = newSocket;
      retryScheduledRef.current = false;
    } else {
      // Failed to get new URL, schedule next retry
      retryScheduledRef.current = false;
      scheduleRetry(false);
    }
  }, [getAuth, setAuth, fetchNewTunnelUrl, createSocket]);

  // Schedule retry after delay - only if not already scheduled
  const scheduleRetry = useCallback((isFirstRetry = true) => {
    if (retryScheduledRef.current) return;
    
    const delay = isFirstRetry ? RETRY_CONFIG.initialDelay : RETRY_CONFIG.interval;
    retryScheduledRef.current = true;
    
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(startRetry, delay);
  }, [startRetry]);

  // Setup socket event handlers
  const setupSocketHandlers = useCallback((socket, auth) => {
    socket.on("connect", () => {
      setConnected(true);
      setError("");
      cancelRetry();
      onConnect?.(socket, auth);
    });

    socket.on("disconnect", (reason) => {
      setConnected(false);
      onDisconnect?.(reason);

      // Schedule retry with API key after delay (only once)
      if (reason !== "io client disconnect") {
        scheduleRetry();
      }
    });

    socket.on("connect_error", () => {
      setError("Connection failed");
      setConnected(false);
      // Schedule retry on connection error (only once)
      scheduleRetry();
    });
  }, [cancelRetry, scheduleRetry, onConnect, onDisconnect]);

  // Store setupSocketHandlers in ref for use in startRetry
  setupSocketHandlersRef.current = setupSocketHandlers;

  // Initialize socket
  useEffect(() => {
    const auth = getAuth();

    if (!auth?.tunnelUrl) {
      router.push(redirectOnNoAuth);
      return;
    }

    const socket = createSocket(auth.tunnelUrl, auth);
    setupSocketHandlers(socket, auth);
    socketRef.current = socket;

    // iOS Safari visibility change handler
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelRetry();
      socket.disconnect();
      socketRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    socket: socketRef.current,
    socketRef,
    connected,
    error,
    retryStatus
  };
}
