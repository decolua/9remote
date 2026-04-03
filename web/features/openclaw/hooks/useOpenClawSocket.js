"use client";
import { useCallback } from "react";
import { useBaseSocket } from "@/shared/hooks/useBaseSocket";

/**
 * OpenClaw socket hook - connects to /openclaw namespace
 * Similar to useSocket but for OpenClaw-specific connection
 */
export function useOpenClawSocket() {
  const handleSocketReady = useCallback((socket) => {
    // Socket ready, no special setup needed here
    // Event handlers will be registered in useOpenClaw hook
  }, []);

  const { socket, socketRef, connected, connectionMode, retryStatus } = useBaseSocket({
    namespace: "/openclaw",
    redirectOnNoAuth: "/",
    onConnect: handleSocketReady,
    onDisconnect: () => {}
  });

  return {
    socket,
    socketRef,
    connected,
    connectionMode,
    retryStatus
  };
}
