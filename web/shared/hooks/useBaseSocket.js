"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { useDeviceId } from "./useDeviceId";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { debugLog } from "@/shared/utils/debugLog";

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
  const [transport, setTransport] = useState("ws");
  const [retryStatus, setRetryStatus] = useState({
    isRetrying: false, attempt: 0, maxAttempts: 10, failed: false
  });

  useEffect(() => {
    const auth = getAuth();
    if (!auth?.tunnelUrl) {
      router.push(redirectOnNoAuth);
      return;
    }

    const wsConfig = {
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace,
      socketOptions: { ...socketOptions, auth: { apiKey: auth.apiKey, tempKey: auth.tempKey ?? null, deviceId, ...socketOptions.auth } },
      apiKey: auth.apiKey,
      tempKey: auth.tempKey ?? null,
      onConnect: (socket, mode) => {
        socketRef.current = socket;
        setConnected(true);
        setConnectionMode(mode || protocolRef.current?.connectionMode || "tunnel");
        debugLog("transport", "[transport] ws connected");
        onConnect?.(socket, auth);
      },
      onDisconnect: (reason) => {
        debugLog("transport", `[transport] ws disconnect reason=${reason}`);
        socketRef.current = null;
        setConnected(false);
        onDisconnect?.(reason);
      },
      onRetryStatus: setRetryStatus
    };

    const rtcConfig = REMOTE_CONFIG.enableWebRTC ? {
      enableWebRTC: true,
      enableTurn: REMOTE_CONFIG.enableTurn,
      apiKey: auth.apiKey,
      onUpgrade: (via) => debugLog("transport", `[transport] upgraded to ${via}`),
      onFallback: (to) => debugLog("transport", `[transport] fallback to ${to}`),
      onTransportChange: (type) => {
        setTransport(type);
        debugLog("transport", `[transport] active=${type}`);
      }
    } : null;

    const protocol = new ProtocolManager(wsConfig, rtcConfig);
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

  return { socket: socketRef.current, socketRef, protocolRef, connected, connectionMode, transport, retryStatus, disconnect };
}
