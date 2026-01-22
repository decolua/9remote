"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import io from "socket.io-client";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

export function useRemoteSocket() {
  const router = useRouter();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const { getAuth } = useSessionStorage();

  // Initialize socket connection - only when component mounts
  useEffect(() => {
    const auth = getAuth();
    if (!auth?.apiKey) {
      router.push("/");
      return;
    }

    const tunnelUrl = auth?.tunnelUrl;
    if (!tunnelUrl) {
      router.push("/terminal");
      return;
    }

    const serverUrl = `${tunnelUrl}${REMOTE_CONFIG.namespace}`;
    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 20000,
      forceNew: true,
      auth: { apiKey: auth.apiKey },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setAuthenticated(true);
      setError("");
      socket.emit("get-screen-dimensions");
    });

    socket.on("disconnect", (reason) => {
      setConnected(false);
      setStreaming(false);
      setAuthenticated(false);
      // Manual reconnect for iOS Safari background mode
      if (reason === "transport close" || reason === "ping timeout") {
        setTimeout(() => socket.connect(), 1000);
      }
    });

    socket.on("connect_error", () => {
      setError("Connection failed");
      setConnected(false);
    });

    // iOS Safari visibility change - reconnect when app becomes visible
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Cleanup on unmount
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (socket) {
        socket.emit("stop-streaming");
        socket.disconnect();
      }
      socketRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Start streaming
  const startStreaming = useCallback(() => {
    if (socketRef.current && connected) {
      socketRef.current.emit("start-streaming");
      setStreaming(true);
    }
  }, [connected]);

  // Stop streaming
  const stopStreaming = useCallback(() => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("stop-streaming");
      setStreaming(false);
    }
  }, [streaming]);

  // Emit functions
  const emitMousePress = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-press", { x, y, button });
    }
  }, [streaming]);

  const emitMouseRelease = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-release", { x, y, button });
    }
  }, [streaming]);

  const emitMouseClick = useCallback((x, y, button = "left") => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-click", { x, y, button });
    }
  }, [streaming]);

  const emitMouseMove = useCallback((x, y) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-move", { x, y });
    }
  }, [streaming]);

  const emitMouseDragSelect = useCallback((startX, startY, endX, endY) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("mouse-drag-select", { startX, startY, endX, endY });
    }
  }, [streaming]);

  const emitKeyPress = useCallback((key, modifier = []) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("key-press", { key, modifier });
    }
  }, [streaming]);

  const emitTypeText = useCallback((text) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("type-text", { text });
    }
  }, [streaming]);

  const emitScroll = useCallback((direction, amount = 20) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("scroll", { direction, amount });
    }
  }, [streaming]);

  const emitRequestScreenWithHashes = useCallback((tileHashes) => {
    if (socketRef.current && streaming) {
      socketRef.current.emit("request-screen-with-hashes", { tileHashes });
    }
  }, [streaming]);

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
  }, [streaming, router]);

  return {
    socket: socketRef.current,
    connected,
    streaming,
    error,
    authenticated,
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
