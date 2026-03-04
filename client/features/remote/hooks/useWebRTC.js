"use client";

import { useCallback } from "react";
import { useBaseDataChannel } from "@/shared/hooks/useBaseDataChannel";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";

/**
 * WebRTC hook — thin wrapper over useBaseDataChannel.
 * On DC open: attaches the DataChannel to RemoteTransport so tiles flow through it.
 * On DC close/fail: detaches from transport, WS takes over automatically.
 */
export function useWebRTC({ socketRef, apiKey, transportRef, onReady }) {
  const handleConnect = useCallback((via, dc) => {
    transportRef?.current?.attachDataChannel(dc);
    onReady?.(via);
  }, [transportRef, onReady]);

  const handleDisconnect = useCallback((reason) => {
    transportRef?.current?.detachDataChannel();
    // Signal WS fallback only when DC never opened (ICE/offer errors)
    if (reason !== "dc-closed") {
      onReady?.("ws");
    }
  }, [transportRef, onReady]);

  const { start, stop, pcRef, dcRef, connected } = useBaseDataChannel({
    socketRef,
    apiKey,
    enableTurn: REMOTE_CONFIG.enableTurn,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect
  });

  return { start, stop, pcRef, dataChannelRef: dcRef, connected };
}
