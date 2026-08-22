"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { useDeviceId } from "./useDeviceId";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";

/**
 * Persist rotated tunnelUrl/localIp back to sessionStorage
 * so other consumers (fetch /api/local-sites, proxy) use fresh URL.
 */
function persistAuthUpdate({ tunnelUrl, localIp }) {
  if (typeof window === "undefined") return;
  // Storage may be blocked (private mode / sandboxed iframe) — best-effort
  try {
    if (tunnelUrl) sessionStorage.setItem("tunnelUrl", tunnelUrl);
    if (localIp) sessionStorage.setItem("localIp", localIp);
    else if (localIp === null) sessionStorage.removeItem("localIp");
  } catch {}
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
  const deviceId = useDeviceId();

  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState("ws");
  const [connectionMode, setConnectionMode] = useState("tunnel");
  const [retryStatus, setRetryStatus] = useState({
    isRetrying: false, attempt: 0, maxAttempts: 10, failed: false
  });

  useEffect(() => {
    const auth = getAuth();
    if (!auth?.apiKey) {
      router.push(redirectOnNoAuth);
      return;
    }

    let manager = null;

    const wsConfig = {
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace,
      // The adapters sign a fresh proof per connect attempt, so admission is
      // decided straight from the handshake with no challenge round-trip. The
      // pairing fp2 is NOT sent here: it must stay unknown to the server
      // (enrollment goes over RTC instead).
      socketOptions: { ...socketOptions, auth: { apiKey: auth.apiKey, deviceId, ...socketOptions.auth } },
      apiKey: auth.apiKey,
      deviceId,
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

    // Browser RTC capability gate — bail to tunnel-only on unsupported/private mode
    // instead of attempting a handshake that can never succeed.
    const rtcCapable = enableWebRTC && typeof RTCPeerConnection !== "undefined";
    const rtcConfig = rtcCapable ? {
      enableWebRTC: true,
      enableTurn,
      apiKey: auth.apiKey,
      onTransportChange: (type) => setTransport(type)
    } : null;

    // Proof is signed per connect attempt inside the adapters (freshAuth) —
    // it expires in minutes and socket.io reconnects on its own.
    manager = new ProtocolManager(wsConfig, rtcConfig);
    managerRef.current = manager;
    manager.connect();

    return () => {
      manager?.disconnect();
      managerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable protocol ref — consumers can call on/off/emit without deps
  const protocol = managerRef.current;

  return { protocol, transport, connectionMode, connected, retryStatus, managerRef };
}
