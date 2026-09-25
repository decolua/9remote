"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSessionStorage } from "./useSessionStorage";
import { useDeviceId } from "./useDeviceId";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { debugLog } from "@/shared/utils/debugLog";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { isLoopbackOrigin, isLocalAgentNetwork } from "@/shared/utils/localOrigin";
import { AGENT_PORT, LOCAL_AGENT_STATE } from "@/shared/constants/API";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";

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
  const { getAuth, setAuth } = useSessionStorage();
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
  // Re-key in place: switching hosts bumps authKey (setAuthData), this effect
  // tears the old ProtocolManager down and builds a fresh one for the new auth.
  const authKey = useConnectionStore((s) => s.authKey);
  // True once a connection has existed: a host switch must not blink the page
  // back to its loading gate while the new connection comes up (the old bus is
  // torn down first, so a reset here would leave nothing to show).
  const hadConnectionRef = useRef(false);
  // Bumped by reconnect(): re-runs the effect for the SAME auth, which is the
  // only way back after a deliberate disconnect (authKey did not change).
  const [reconnectSeq, setReconnectSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let protocol = null;

    const start = async () => {
      let auth = getAuth();
      // Agent-served page on the agent's own port: the loopback carrier always
      // wins over any stored remote auth (a stale tunnel login), so the key is
      // read straight from the agent.
      //
      // Deliberately NOT done on the web dev server, which is loopback too but
      // is not the agent: auto-minting a session there would skip the login
      // screen entirely, which is exactly what a build must not do.
      const isLoopback = isLoopbackOrigin();
      // `!authKey` guards a re-key: once the user has deliberately switched the
      // workspace onto another host, that intent outranks the local agent's key.
      if (isLoopback && window.location.port === String(AGENT_PORT) && !authKey && auth?.tunnelUrl !== window.location.origin) {
        try {
          const res = await fetch(LOCAL_AGENT_STATE);
          const data = res.ok ? await res.json() : null;
          if (res.ok) {
            if (data?.permanentKey) {
              const fullKey = data.permanentKey;
              const head = headOf(fullKey);
              const tail = tailOf(fullKey);
              setTrust(head, { tail });
              auth = {
                apiKey: head,
                tunnelUrl: window.location.origin,
                mode: "local",
                tempKey: null,
                localIp: data.localIp || null
              };
              setAuth(auth);
            }
          }
        } catch {}
      }

      if (cancelled) return;
      if (!auth?.apiKey) {
        // Nothing to connect with — the mirror must not keep a bus from a
        // session that no longer exists (cleanup no longer resets on re-key).
        useConnectionStore.getState().reset();
        router.push(redirectOnNoAuth);
        return;
      }
      // A deliberate disconnect sticks across reloads: boot into the workspace
      // with the host offline (its connect button is the way back), not into a
      // loading gate. reconnect() clears the flag and re-runs this effect.
      try {
        if (sessionStorage.getItem("9remote_manual_disconnect") === "1") {
          useConnectionStore.getState().setConnection({ deliberate: true });
          return;
        }
      } catch {}

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
          if (cancelled) return;
          hadConnectionRef.current = true;
          busRef.current = bus;
          useConnectionStore.getState().setConnection({ deliberate: false, everConnected: true });
          const cMode = mode || protocolRef.current?.connectionMode || "tunnel";
          setConnected(true);
          setConnectionMode(cMode);
          useConnectionStore.getState().setConnection({
            bus,
            connected: true,
            connectionMode: cMode,
            endpoint: auth.tunnelUrl
          });
          debugLog("transport", "[transport] ws connected");
          onConnect?.(bus, auth);
        },
        onDisconnect: (reason) => {
          if (cancelled) return;
          debugLog("transport", `[transport] ws disconnect reason=${reason}`);
          busRef.current = null;
          setConnected(false);
          useConnectionStore.getState().setConnection({ connected: false });
          onDisconnect?.(reason);
        },
        // Device-approval answer over signaling (no tunnel needed to show the modal)
        onApproval,
        onRetryStatus: (st) => {
          if (cancelled) return;
          setRetryStatus(st);
          useConnectionStore.getState().setRetryStatus(st);
        }
      };

      // The carrier IS the page's own origin (agent-served workspace): the
      // direct WS beats every other carrier, so RTC (and its DO signaling) is
      // pure overhead — skip both. A dev server on localhost whose carrier is
      // a remote tunnelUrl keeps the full RTC stack.
      const carrierIsPageOrigin = auth.tunnelUrl === window.location.origin;
      const wantRtc = REMOTE_CONFIG.enableWebRTC && !carrierIsPageOrigin;
      const rtcConfig = wantRtc ? {
        enableWebRTC: true,
        enableTurn: REMOTE_CONFIG.enableTurn,
        apiKey: auth.apiKey,
        onUpgrade: (via) => debugLog("transport", `[transport] upgraded to ${via}`),
        onFallback: (to) => debugLog("transport", `[transport] fallback to ${to}`),
        onTransportChange: (type) => {
          if (cancelled) return;
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
      // First connect: nothing to show yet, so the gate is honest. A re-key is
      // not that — the new bus replaces the old one immediately (emits buffer
      // until it opens), so the connection's live verdicts carry over rather
      // than flipping the page to a loading screen. The standing approval
      // verdict is cleared where the new bus binds its listeners (useAgentBus),
      // not here: this runs before them, so an answer that arrives first would
      // be wiped by the clear.
      useConnectionStore.getState().setConnection({
        bus: busRef.current,
        busRef,
        protocolRef,
        deliberate: false,
        ...(hadConnectionRef.current ? {} : { connected: false, admitted: false }),
        connectionMode: "tunnel",
        carrier: "ws"
      });
      protocol.connect();
    };

    start();

    return () => {
      cancelled = true;
      protocol?.disconnect();
      protocolRef.current = null;
      busRef.current = null;
      // Deliberately no reset(): on a re-key the next effect has already replaced
      // the mirror, and resetting here would null the bus the page is rendering
      // from. A real teardown (logout, leaving the workspace) goes through
      // disconnect(), which does reset.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per authKey/reconnect: a host switch re-keys, a reconnect re-arms
  }, [authKey, reconnectSeq]);

  // Expose manual disconnect (used e.g. on device:rejected to stop auto-reconnect)
  const disconnect = () => {
    protocolRef.current?.disconnect();
    protocolRef.current = null;
    busRef.current = null;
    setConnected(false);
    useConnectionStore.getState().reset();
    // reset() clears it — set AFTER, so the page knows this was on purpose.
    useConnectionStore.getState().setConnection({ deliberate: true });
    try { sessionStorage.setItem("9remote_manual_disconnect", "1"); } catch {}
  };

  // The way back from a deliberate disconnect: same auth, fresh attempt.
  const reconnect = () => {
    try { sessionStorage.removeItem("9remote_manual_disconnect"); } catch {}
    setReconnectSeq((n) => n + 1);
  };

  return { bus: busRef.current, busRef, protocolRef, connected, connectionMode, carrier, retryStatus, disconnect, reconnect };
}
