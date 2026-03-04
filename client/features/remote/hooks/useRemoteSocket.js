"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";
import { RemoteTransport } from "@/features/remote/utils/remoteTransport";
import { useWebRTC } from "./useWebRTC";

export function useRemoteSocket() {
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const [streaming, setStreaming] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [transport, setTransport] = useState("ws"); // "ws" | "dc-stun" | "dc-turn"
  const [transportVersion, setTransportVersion] = useState(0);
  const mountedRef = useRef(true);

  // RemoteTransport instance — created once, lives for the socket lifetime
  const remoteTransportRef = useRef(null);

  const auth = getAuth();

  // DC open → upgrade transport indicator, tiles now flow via DC
  const handleWebRTCReady = useCallback((via) => {
    if (!mountedRef.current) return;
    setTransport(via.startsWith("dc") ? via : "ws");
  }, []);

  const webrtcSocketRef = useRef(null);

  const { start: startWebRTC, stop: stopWebRTC } = useWebRTC({
    socketRef: webrtcSocketRef,
    apiKey: auth?.apiKey,
    transportRef: remoteTransportRef,
    onReady: handleWebRTCReady
  });

  // Handle connect — build transport, start WebRTC negotiation in background
  const handleConnect = useCallback((socket) => {
    if (!mountedRef.current) return;
    setAuthenticated(true);
    socket.emit("get-screen-dimensions");
    webrtcSocketRef.current = socket;

    // Create/replace transport bound to the new socket
    remoteTransportRef.current?.destroy();
    remoteTransportRef.current = new RemoteTransport(socket);
    // Bump version so consumers re-register listeners on the new transport instance
    setTransportVersion((v) => v + 1);

    if (REMOTE_CONFIG.enableWebRTC) startWebRTC();
  }, [startWebRTC]);

  // Handle disconnect — tear down DC + transport
  const handleDisconnect = useCallback(() => {
    if (!mountedRef.current) return;
    setStreaming(false);
    setAuthenticated(false);
    setTransport("ws");
    stopWebRTC();
    remoteTransportRef.current?.destroy();
    remoteTransportRef.current = null;
  }, [stopWebRTC]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const { socket, socketRef, connected, error, retryStatus } = useBaseSocket({
    namespace: REMOTE_CONFIG.namespace,
    socketOptions: {
      timeout: 20000,
      forceNew: true,
      auth: { apiKey: auth?.apiKey }
    },
    redirectOnNoAuth: "/",
    onConnect: handleConnect,
    onDisconnect: handleDisconnect
  });

  // Redirect if no auth
  useEffect(() => {
    if (!auth?.apiKey) {
      router.push("/");
    } else if (!auth?.tunnelUrl) {
      router.push("/workspace");
    }
  }, [auth, router]);

  // ── Streaming ────────────────────────────────────────────────────────────

  const startStreaming = useCallback(() => {
    if (!socketRef.current || !connected) return;
    socketRef.current.emit("start-streaming");
    setStreaming(true);
  }, [socketRef, connected]);

  const stopStreaming = useCallback(() => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("stop-streaming");
      setStreaming(false);
    }
  }, [socketRef, streaming]);

  // ── Mouse emitters ───────────────────────────────────────────────────────

  const emitMousePress = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) socketRef.current.emit("mouse-press", { x, y, button });
  }, [socketRef, streaming]);

  const emitMouseRelease = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) socketRef.current.emit("mouse-release", { x, y, button });
  }, [socketRef, streaming]);

  const emitMouseClick = useCallback((x, y, button = "left", double = false) => {
    if (socketRef.current && streaming) socketRef.current.emit("mouse-click", { x, y, button, double });
  }, [socketRef, streaming]);

  const emitMouseMove = useCallback((x, y) => {
    if (socketRef.current && streaming) socketRef.current.emit("mouse-move", { x, y });
  }, [socketRef, streaming]);

  const emitMouseDragSelect = useCallback((startX, startY, endX, endY) => {
    if (socketRef.current && streaming) socketRef.current.emit("mouse-drag-select", { startX, startY, endX, endY });
  }, [socketRef, streaming]);

  // ── Key emitters ─────────────────────────────────────────────────────────

  const emitKeyPress = useCallback((key, modifier = []) => {
    if (socketRef.current && streaming) socketRef.current.emit("key-press", { key, modifier });
  }, [socketRef, streaming]);

  const emitTypeText = useCallback((text) => {
    if (socketRef.current && streaming) socketRef.current.emit("type-text", { text });
  }, [socketRef, streaming]);

  // ── Misc emitters ────────────────────────────────────────────────────────

  const emitScroll = useCallback((direction, amount = 20, horizontal = false) => {
    if (socketRef.current && streaming) socketRef.current.emit("scroll", { direction, amount, horizontal });
  }, [socketRef, streaming]);

  const emitBoostStream = useCallback(() => {
    if (socketRef.current && streaming) socketRef.current.emit("boost-stream");
  }, [socketRef, streaming]);

  const emitRequestScreenWithHashes = useCallback((tileHashes) => {
    if (socketRef.current && streaming) socketRef.current.emit("request-screen-with-hashes", { tileHashes });
  }, [socketRef, streaming]);

  // ── Logout ───────────────────────────────────────────────────────────────

  const handleLogout = useCallback(() => {
    if (streaming && socketRef.current) {
      socketRef.current.emit("stop-streaming");
      setStreaming(false);
    }
    socketRef.current?.disconnect();
    router.push("/workspace");
  }, [socketRef, streaming, router]);

  return {
    socket,
    socketRef,
    remoteTransportRef,
    transportVersion,
    connected,
    streaming,
    error,
    authenticated,
    retryStatus,
    transport,
    startStreaming,
    stopStreaming,
    handleLogout,
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll,
    emitBoostStream
  };
}
