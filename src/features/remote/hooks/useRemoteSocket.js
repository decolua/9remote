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

  // Initialize socket connection
  useEffect(() => {
    const auth = getAuth();
    if (!auth?.apiKey) {
      router.push("/");
      return;
    }

    // Use tunnel URL from session storage (same as terminal)
    const tunnelUrl = auth?.tunnelUrl;
    if (!tunnelUrl) {
      console.error("❌ No tunnel URL found");
      router.push("/terminal");
      return;
    }

    // Connect to remote namespace via tunnel URL
    const serverUrl = `${tunnelUrl}${REMOTE_CONFIG.namespace}`;
    console.log("🔌 Connecting to:", serverUrl);

    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      timeout: 20000,
      forceNew: true,
      auth: { apiKey: auth.apiKey }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("🔌 Remote socket connected");
      setConnected(true);
      setAuthenticated(true);
      setError("");
      // Get screen dimensions immediately
      socket.emit("get-screen-dimensions");
    });

    socket.on("disconnect", () => {
      console.log("🔌 Remote socket disconnected");
      setConnected(false);
      setStreaming(false);
      setAuthenticated(false);
    });

    socket.on("connect_error", (err) => {
      console.error("❌ Connection error:", err);
      setError("Connection failed");
      setConnected(false);
    });

    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, [router, getAuth]);

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
