"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";

/**
 * Persist rotated tunnelUrl/localIp back to sessionStorage
 * so other consumers (fetch /api/local-sites, proxy) use fresh URL.
 */
function persistAuthUpdate({ tunnelUrl, localIp }) {
  if (typeof window === "undefined") return;
  if (tunnelUrl) sessionStorage.setItem("tunnelUrl", tunnelUrl);
  if (localIp) sessionStorage.setItem("localIp", localIp);
  else if (localIp === null) sessionStorage.removeItem("localIp");
}

/**
 * useProtocol — universal transport hook.
 *
 * Wraps ProtocolManager (WS primary + WebRTC upgrade/fallback).
 * Returns a stable `protocol` ref usable anywhere in the app.
 *
 * Usage:
 *   const { protocol, transport, connected, retryStatus } = useProtocol({
 *     namespace: "/remote",
 *     socketOptions: { auth: { apiKey } },
 *     enableWebRTC: true,
 *     enableTurn: false,
 *     redirectOnNoAuth: "/"
 *   });
 *   protocol.on("tiles-data", handler);
 *   protocol.emit("mouse-move", { x, y });
 */
export function useProtocol({
  namespace = "",
  socketOptions = {},
  enableWebRTC = false,
  enableTurn = false,
  redirectOnNoAuth = "/",
  onConnect,
  onDisconnect
} = {}) {
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const managerRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState("ws");
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

    const wsConfig = {
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace,
      socketOptions: { ...socketOptions, auth: { apiKey: auth.apiKey, ...socketOptions.auth } },
      apiKey: auth.apiKey,
      onConnect: (socket) => {
        setConnected(true);
        setConnectionMode(managerRef.current?.connectionMode || "tunnel");
        onConnect?.(socket);
      },
      onDisconnect: (reason) => {
        setConnected(false);
        onDisconnect?.(reason);
      },
      onRetryStatus: setRetryStatus,
      onUrlUpdate: persistAuthUpdate
    };

    const rtcConfig = enableWebRTC ? {
      enableWebRTC: true,
      enableTurn,
      apiKey: auth.apiKey,
      onTransportChange: (type) => setTransport(type)
    } : null;

    const manager = new ProtocolManager(wsConfig, rtcConfig);
    managerRef.current = manager;
    manager.connect();

    return () => {
      manager.disconnect();
      managerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable protocol ref — consumers can call on/off/emit without deps
  const protocol = managerRef.current;

  return { protocol, transport, connectionMode, connected, retryStatus, managerRef };
}
