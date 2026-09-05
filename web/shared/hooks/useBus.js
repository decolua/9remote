"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { useDeviceId } from "./useDeviceId";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { debugLog } from "@/shared/utils/debugLog";
import { useConnectionStore } from "@/shared/stores/connectionStore";

/**
 * Owns the ProtocolManager and hands back its bus — the one object the app talks
 * to. Not a bus: socket.io is only one of the carriers underneath (RTC is the
 * other), and which one is live changes freely without the bus identity changing.
 * Handles local-first connect, retry, and visibility reconnect.
 */
export function useBus(config = {}) {
  const {
    namespace = "",
    socketOptions = {},
    redirectOnNoAuth = "/",
    onConnect,
    onDisconnect,
    onApproval
  } = config;

  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const deviceId = useDeviceId();

  const busRef = useRef(null);
  const protocolRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState("tunnel");
  // Which carrier is currently active ("ws" | "dc") — NOT the transport layer as a
  // whole, which is why it is not called `transport`: everything in this hook rides
  // the transport, only this says over which carrier.
  const [carrier, setCarrier] = useState("ws");
  const [retryStatus, setRetryStatus] = useState({
    isRetrying: false, attempt: 0, maxAttempts: 10, failed: false
  });

  useEffect(() => {
    const auth = getAuth();
    if (!auth?.apiKey) {
      router.push(redirectOnNoAuth);
      return;
    }

    let protocol = null;

    const wsConfig = {
      tunnelUrl: auth.tunnelUrl,
      localIp: auth.localIp || null,
      namespace,
      // The adapters attach a freshly-signed proof per connect attempt, so
      // admission is decided straight from the handshake — no challenge
      // round-trip, no timeout. The pairing fp2 is
      // deliberately NOT sent here: the handshake rides the tunnel, and fp2 must
      // stay unknown to the server (enrollment goes over RTC instead).
      socketOptions: { ...socketOptions, auth: { apiKey: auth.apiKey, tempKey: auth.tempKey ?? null, deviceId, ...socketOptions.auth } },
      apiKey: auth.apiKey,
      deviceId,
      tempKey: auth.tempKey ?? null,
      onConnect: (bus, mode) => {
        busRef.current = bus;
        const cMode = mode || protocolRef.current?.connectionMode || "tunnel";
        setConnected(true);
        setConnectionMode(cMode);
        useConnectionStore.getState().setConnection({
          bus,
          connected: true,
          connectionMode: cMode
        });
        debugLog("transport", "[transport] ws connected");
        onConnect?.(bus, auth);
      },
      onDisconnect: (reason) => {
        debugLog("transport", `[transport] ws disconnect reason=${reason}`);
        busRef.current = null;
        setConnected(false);
        useConnectionStore.getState().setConnection({ connected: false });
        onDisconnect?.(reason);
      },
      // Device-approval answer over signaling (no tunnel needed to show the modal)
      onApproval,
      onRetryStatus: (st) => {
        setRetryStatus(st);
        useConnectionStore.getState().setRetryStatus(st);
      }
    };

    const rtcConfig = REMOTE_CONFIG.enableWebRTC ? {
      enableWebRTC: true,
      enableTurn: REMOTE_CONFIG.enableTurn,
      apiKey: auth.apiKey,
      onUpgrade: (via) => debugLog("transport", `[transport] upgraded to ${via}`),
      onFallback: (to) => debugLog("transport", `[transport] fallback to ${to}`),
      onTransportChange: (type) => {
        setCarrier(type);
        useConnectionStore.getState().setCarrier(type);
        debugLog("transport", `[transport] active=${type}`);
      }
    } : null;

    // The device proof is NOT built here: it expires in minutes and socket.io
    // reconnects on its own, so it is computed per connect attempt inside the
    // adapters (see adapters/freshAuth).
    protocol = new ProtocolManager(wsConfig, rtcConfig);
    protocolRef.current = protocol;
    busRef.current = protocol.busRef.current;
    useConnectionStore.getState().setConnection({
      bus: busRef.current,
      busRef,
      protocolRef,
      connected: false,
      connectionMode: "tunnel",
      carrier: "ws"
    });
    protocol.connect();

    return () => {
      protocol?.disconnect();
      protocolRef.current = null;
      busRef.current = null;
      useConnectionStore.getState().reset();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose manual disconnect (used e.g. on device:rejected to stop auto-reconnect)
  const disconnect = () => {
    protocolRef.current?.disconnect();
    protocolRef.current = null;
    busRef.current = null;
    setConnected(false);
    useConnectionStore.getState().reset();
  };

  return { bus: busRef.current, busRef, protocolRef, connected, connectionMode, carrier, retryStatus, disconnect };
}
