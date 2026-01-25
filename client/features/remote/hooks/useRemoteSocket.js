"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

export function useRemoteSocket() {
  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const [streaming, setStreaming] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  // Get auth for socket options
  const auth = getAuth();

  // Handle connect
  const handleConnect = useCallback((socket) => {
    setAuthenticated(true);
    socket.emit("get-screen-dimensions");
  }, []);

  // Handle disconnect
  const handleDisconnect = useCallback(() => {
    setStreaming(false);
    setAuthenticated(false);
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

  // Redirect if no apiKey
  useEffect(() => {
    if (!auth?.apiKey) {
      router.push("/");
    } else if (!auth?.tunnelUrl) {
      router.push("/terminal");
    }
  }, [auth, router]);

  // Start streaming
  const startStreaming = useCallback(() => {
    if (socketRef.current && connected) {
      socketRef.current.emit("start-streaming");
      setStreaming(true);
    }
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
  const emitScroll = useCallback((direction, amount = 20) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("scroll", { direction, amount });
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
    router.push("/terminal");
  }, [socketRef, streaming, router]);

  return {
    socket,
    connected,
    streaming,
    error,
    authenticated,
    retryStatus,
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
    emitScroll
  };
}
