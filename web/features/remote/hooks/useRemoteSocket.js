"use client";

import { useState, useCallback, useEffect } from "react";

export function useRemoteSocket(socketRef, connected) {
  const [streaming, setStreaming] = useState(false);

  // Track streaming state alongside the effect in RemoteDesktop
  useEffect(() => {
    if (!connected || !socketRef?.current) return;
    setStreaming(true);
    return () => setStreaming(false);
  }, [connected, socketRef]);

  const emit = useCallback((event, data) => {
    socketRef?.current?.emit(event, data);
  }, [socketRef]);

  // ── Mouse emitters ─────────────────────────────────────────────────────────

  const emitMousePress = useCallback((x, y, button = "left") => {
    if (streaming) emit("mouse-press", { x, y, button });
  }, [emit, streaming]);

  const emitMouseRelease = useCallback((x, y, button = "left") => {
    if (streaming) emit("mouse-release", { x, y, button });
  }, [emit, streaming]);

  const emitMouseClick = useCallback((x, y, button = "left", double = false) => {
    if (streaming) emit("mouse-click", { x, y, button, double });
  }, [emit, streaming]);

  const emitMouseMove = useCallback((x, y) => {
    if (streaming) emit("mouse-move", { x, y });
  }, [emit, streaming]);

  const emitMouseDragSelect = useCallback((startX, startY, endX, endY) => {
    if (streaming) emit("mouse-drag-select", { startX, startY, endX, endY });
  }, [emit, streaming]);

  // ── Key emitters ───────────────────────────────────────────────────────────

  const emitKeyPress = useCallback((key, modifier = []) => {
    if (streaming) emit("key-press", { key, modifier });
  }, [emit, streaming]);

  const emitTypeText = useCallback((text) => {
    if (streaming) emit("type-text", { text });
  }, [emit, streaming]);

  // ── Misc emitters ──────────────────────────────────────────────────────────

  const emitScroll = useCallback((direction, amount = 20, horizontal = false) => {
    if (streaming) emit("scroll", { direction, amount, horizontal });
  }, [emit, streaming]);

  const emitBoostStream = useCallback(() => {
    if (streaming) emit("boost-stream");
  }, [emit, streaming]);

  // rect=null + zoom=1 tells server to apply the "full view" quality profile.
  // viewerWidth + dpr let server compute effective pixel density for adaptive tier.
  const emitSetFocus = useCallback((rect, zoom = 1) => {
    if (!streaming) return;
    const viewerWidth = typeof window !== "undefined" ? window.innerWidth : 0;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    emit("set-focus", { rect, zoom, viewerWidth, dpr });
  }, [emit, streaming]);

  const emitRequestScreenWithHashes = useCallback((tileHashes) => {
    if (streaming) emit("request-screen-with-hashes", { tileHashes });
  }, [emit, streaming]);

  const emitDesktopSwitch = useCallback((direction) => {
    if (streaming) emit("desktop-switch", { direction });
  }, [emit, streaming]);

  return {
    streaming,
    emitRequestScreenWithHashes,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseMove,
    emitMouseDragSelect,
    emitKeyPress,
    emitTypeText,
    emitScroll,
    emitBoostStream,
    emitSetFocus,
    emitDesktopSwitch
  };
}
