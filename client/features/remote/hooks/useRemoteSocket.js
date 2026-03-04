"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";
import { useWebRTC } from "./useWebRTC";

export function useRemoteSocket({ onWebRTCTilesData } = {}) {
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const [streaming, setStreaming] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [transport, setTransport] = useState("ws"); // "ws" | "dc"
  const mountedRef = useRef(true);

  const auth = getAuth();

  // WebRTC fallback — DC failed, stay on WS (already default)
  const handleWebRTCFallback = useCallback(() => {
    if (!mountedRef.current) return;
    setTransport("ws");
  }, []);

  // DC open → upgrade transport, tiles now come via DC
  const handleWebRTCReady = useCallback((via) => {
    if (!mountedRef.current) return;
    // via: "dc-stun" | "dc-turn" | "ws"
    setTransport(via.startsWith("dc") ? via : "ws");
  }, []);

  // Shared socketRef — synced after socket connects
  const webrtcSocketRef = useRef(null);

  const { start: startWebRTC, stop: stopWebRTC } = useWebRTC({
    socketRef: webrtcSocketRef,
    apiKey: auth?.apiKey,
    onFallback: handleWebRTCFallback,
    onReady: handleWebRTCReady,
    onTilesData: onWebRTCTilesData
  });

  // Handle connect — start WS immediately, negotiate WebRTC in background if enabled
  const handleConnect = useCallback((socket) => {
    if (!mountedRef.current) return;
    setAuthenticated(true);
    socket.emit("get-screen-dimensions");
    webrtcSocketRef.current = socket;
    if (REMOTE_CONFIG.enableWebRTC) startWebRTC();
  }, [startWebRTC]);

  // Handle disconnect
  const handleDisconnect = useCallback(() => {
    if (!mountedRef.current) return;
    setStreaming(false);
    setAuthenticated(false);
    setTransport("ws");
    stopWebRTC();
  }, [stopWebRTC]);

  // Cleanup mounted ref
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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

  // Start streaming via WS immediately (DC upgrade happens automatically when ready)
  const startStreaming = useCallback(() => {
    if (!socketRef.current || !connected) return;
    socketRef.current.emit("start-streaming");
    setStreaming(true);
  }, [socketRef, connected]);

  // Stop streaming
  const stopStreaming = useCallback(() => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("stop-streaming");
      setStreaming(false);
    }
  }, [socketRef, streaming]);

  // Mouse emitters
  const emitMousePress = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-press", { x, y, button });
    }
  }, [socketRef, streaming]);

  const emitMouseRelease = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-release", { x, y, button });
    }
  }, [socketRef, streaming]);

  const emitMouseClick = useCallback((x, y, button = "left", double = false) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-click", { x, y, button, double });
    }
  }, [socketRef, streaming]);

  const emitMouseMove = useCallback((x, y) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-move", { x, y });
    }
  }, [socketRef, streaming]);

  const emitMouseDragSelect = useCallback((startX, startY, endX, endY) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-drag-select", { startX, startY, endX, endY });
    }
  }, [socketRef, streaming]);

  // Key emitters
  const emitKeyPress = useCallback((key, modifier = []) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("key-press", { key, modifier });
    }
  }, [socketRef, streaming]);

  const emitTypeText = useCallback((text) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("type-text", { text });
    }
  }, [socketRef, streaming]);

  // Scroll
  const emitScroll = useCallback((direction, amount = 20, horizontal = false) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("scroll", { direction, amount, horizontal });
    }
  }, [socketRef, streaming]);

  // Boost stream
  const emitBoostStream = useCallback(() => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("boost-stream");
    }
  }, [socketRef, streaming]);

  // Screen request
  const emitRequestScreenWithHashes = useCallback((tileHashes) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("request-screen-with-hashes", { tileHashes });
    }
  }, [socketRef, streaming]);

  // Logout
  const handleLogout = useCallback(() => {
    if (streaming && socketRef.current) {
      socketRef.current.emit("stop-streaming");
      setStreaming(false);
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    router.push("/workspace");
  }, [socketRef, streaming, router]);

  return {
    socket,
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
