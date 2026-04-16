"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { useDeviceId } from "./useDeviceId";
import { WsProtocol } from "@/shared/transport/WsProtocol";

/**
 * Base socket hook — thin wrapper around WsProtocol.
 * Handles local-first connect, retry, and visibility reconnect.
 * Returns a stable socketRef usable for event registration.
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
  const { getAuth } = useSessionStorage();
  const deviceId = useDeviceId();

  const socketRef = useRef(null);
  const protocolRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState("tunnel");
  const [retryStatus, setRetryStatus] = useState({
    isRetrying: false, attempt: 0, maxAttempts: 10, failed: false
  });

  useEffect(() => {
    const auth = getAuth();
    if (!auth?.tunnelUrl) {
      router.push(redirectOnNoAuth);
      return;
    }

    const protocol = new WsProtocol({
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace,
      socketOptions: { ...socketOptions, auth: { apiKey: auth.apiKey, tempKey: auth.tempKey ?? null, deviceId, ...socketOptions.auth } },
      // Debug: log tempKey being sent
      ...(console.log("[socket auth] tempKey:", auth.tempKey ?? null) && {}),
      apiKey: auth.apiKey,
      onConnect: (socket, mode) => {
        socketRef.current = socket;
        setConnected(true);
        setConnectionMode(mode || "tunnel");
        onConnect?.(socket, auth);
      },
      onDisconnect: (reason) => {
        socketRef.current = null;
        setConnected(false);
        onDisconnect?.(reason);
      },
      onRetryStatus: setRetryStatus
    });

    protocolRef.current = protocol;
    protocol.connect();

    return () => {
      protocol.disconnect();
      protocolRef.current = null;
      socketRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose manual disconnect (used e.g. on device:rejected to stop auto-reconnect)
  const disconnect = () => {
    protocolRef.current?.disconnect();
    protocolRef.current = null;
    socketRef.current = null;
    setConnected(false);
  };

  return { socket: socketRef.current, socketRef, connected, connectionMode, retryStatus, disconnect };
}
