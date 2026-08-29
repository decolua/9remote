"use client";

import { useState, useRef, useEffect } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { tileStatsFrom } from "@/features/remote/lib/tileBinaryHeader";
import { debugLog } from "@/shared/utils/debugLog";

// Screen-stream lifecycle: agent bus listeners, the (re)stream handshake, and the
// keep-alive effects that guarantee a painted canvas (periodic hash sync, dimension
// recovery, pause while hidden). All of it is keyed on the same bus + connection,
// so it lives together.
// Extracted verbatim from RemoteDesktop.
export function useRemoteStream({
  busRef, connected, streaming,
  canvasRef, serverDimensionsRef, handleCanvasDimensions, resetPan,
  zoomGestureTimeoutRef, trackTilesReceived, tiles
}) {
  const [screenLocked, setScreenLocked] = useState(false);
  const [unlockReady, setUnlockReady] = useState(false);
  const [unlockResult, setUnlockResult] = useState(null); // {ok, reason} | null
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardNew, setClipboardNew] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const [activeMonitorIndex, setActiveMonitorIndex] = useState(0);
  const [cursorShape, setCursorShape] = useState(null);
  const lastTileTransportRef = useRef(null);

  const {
    renderedTilesRef, handleFullScreenData, handleTilesData, handleTilesBinary,
    handleTilesBinaryV2, handleTilesMeta, handleScreenDimensions, cleanupTiles,
    requestScreenWithHashes
  } = tiles;

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;

    // Reset stale tile state on (re)connect — stale hashes cause agent to skip tiles → black canvas
    cleanupTiles();

    const onScreenDimensions = (dimensions) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);
    };
    const onFullScreenData = (data) => handleFullScreenData(data);
    const onTilesData = (data) => {
      const via = data.transport || "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}`);
      }
      trackTilesReceived(data, via);
      handleTilesData(data);
    };
    const onScreenError = (err) => console.error("Screen error:", err);

    // Host desktop locked (Winlogon) → show unlock overlay. Emitted by the
    // Windows desktop bridge; ignored on other platforms.
    const onScreenLocked = ({ locked, ready } = {}) => {
      setScreenLocked(!!locked);
      setUnlockReady(!!ready);
      if (locked) setUnlockResult(null);
    };

    // Agent finished the unlock attempt — {ok, reason}.
    const onUnlockResult = (r) => setUnlockResult(r || null);

    // Binary tile frames carry a 12B benchmark header — see lib/tileBinaryHeader.
    const trackBinary = (buffer, label) => {
      const via = "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}${label}`);
      }
      trackTilesReceived(tileStatsFrom(buffer), via);
    };
    const onTilesBinary = (buffer) => {
      trackBinary(buffer, "");
      handleTilesBinary(buffer);
    };
    const onTilesMeta = (meta) => handleTilesMeta(meta);

    // v2 listener — atomic hash embedded per tile (new agent)
    const onTilesBinV2 = (buffer) => {
      trackBinary(buffer, " v2");
      handleTilesBinaryV2(buffer);
    };

    // Fresh handshake: wipe stale client tiles/hashes then request a full frame.
    // Reused on both mount and remote:ready (fired by agent after it (re)attaches
    // handlers for a NEW bus post-reconnect — the reliable "agent is ready" signal,
    // avoiding the race where start-streaming lands before addClient() on the agent).
    const doRestream = () => {
      cleanupTiles();
      bus.emit("get-screen-dimensions");
      // Ask the agent to re-emit the current lock state — the initial
      // screen-locked event fires before this listener mounts (race).
      bus.emit("get-unlock-state");
      // start-streaming alone clears agent checksums + pushes a full frame. Do NOT also
      // emit request-screen-with-hashes: it races the stream loop, fills the agent's
      // lastTileChecksums without delivering a full frame → agent thinks client is
      // synced → only diffs sent → black canvas.
      bus.emit("start-streaming");
    };

    // Agent (re)attached remote handlers on a new bus → reset everything fresh.
    const onRemoteReady = () => doRestream();

    // Host clipboard changed → stash text + badge. Agent seeds baseline on attach
    // (covers empty clipboard), so every event here is a real change worth showing.
    const onClipboardUpdate = ({ text, hash }) => {
      setClipboardText((prev) => {
        if (hash && hash === onClipboardUpdate._lastHash) return prev;
        onClipboardUpdate._lastHash = hash || null;
        return text || "";
      });
      setClipboardNew(true);
    };

    // Multi-monitor list from agent → drives the switcher UI.
    const onMonitors = ({ list, activeIndex }) => {
      setMonitors(Array.isArray(list) ? list : []);
      if (typeof activeIndex === "number") setActiveMonitorIndex(activeIndex);
    };
    // Agent switched the active display → drop stale tiles + reset pan so the
    // next frame paints the new monitor cleanly on a resized canvas. Zoom is
    // kept: it is a ratio, so it stays meaningful across monitor sizes.
    const onFrameMeta = (meta) => {
      cleanupTiles();
      resetPan();
      if (typeof meta?.monitorIndex === "number") setActiveMonitorIndex(meta.monitorIndex);
    };

    bus.on("screen-dimensions", onScreenDimensions);
    bus.on("full-screen-data", onFullScreenData);
    bus.on("tiles-data", onTilesData);
    bus.on("tiles-data-binary", onTilesBinary);
    bus.on("tiles-bin-v2", onTilesBinV2);
    bus.on("tiles-meta", onTilesMeta);
    bus.on("screen-error", onScreenError);
    bus.on("screen-locked", onScreenLocked);
    bus.on("unlock-result", onUnlockResult);
    bus.on("remote:ready", onRemoteReady);
    bus.on("clipboard-update", onClipboardUpdate);
    bus.on("monitors", onMonitors);
    bus.on("frame_meta", onFrameMeta);
    const onCursorShape = (data) => setCursorShape(data?.shape ?? null);
    bus.on("cursor-shape", onCursorShape);

    // Initial handshake on mount — agent may have emitted remote:ready before this
    // component mounted (bus already connected via terminal) so listener missed it.
    doRestream();

    return () => {
      bus.emit("stop-streaming");
      bus.off("screen-dimensions", onScreenDimensions);
      bus.off("full-screen-data", onFullScreenData);
      bus.off("tiles-data", onTilesData);
      bus.off("tiles-data-binary", onTilesBinary);
      bus.off("tiles-bin-v2", onTilesBinV2);
      bus.off("tiles-meta", onTilesMeta);
      bus.off("screen-error", onScreenError);
      bus.off("screen-locked", onScreenLocked);
      bus.off("unlock-result", onUnlockResult);
      bus.off("remote:ready", onRemoteReady);
      bus.off("clipboard-update", onClipboardUpdate);
      bus.off("monitors", onMonitors);
      bus.off("frame_meta", onFrameMeta);
      bus.off("cursor-shape", onCursorShape);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) clearTimeout(zoomGestureTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Periodic sync: once tiles are flowing, re-verify via hashes (steady state).
  // Before the first tile paints, requestScreenWithHashes() skips on empty hashes —
  // so pull a full frame directly (same as the refresh button) until the canvas is
  // no longer empty. Covers the case where start-streaming's initial full frame was
  // lost (transport not ready yet / landed before addClient / decode worker suspended).
  useEffect(() => {
    if (!streaming || !connected || !busRef?.current) return;
    const id = setInterval(() => {
      if (renderedTilesRef.current.size === 0) {
        busRef.current.emit("request-screen-with-hashes", { tileHashes: [] });
      } else {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);
    return () => clearInterval(id);
  }, [streaming, connected, busRef, requestScreenWithHashes, renderedTilesRef]);

  // WS reconnect (new server bus) is handled by the agent's remote:ready event
  // → onRemoteReady → doRestream. No bus.id polling needed.

  // Canvas has no dimensions → tiles draw into a 0×0 canvas → black screen while input
  // still works (mouse coords use %). Happens on re-entry: a fresh <canvas> mounts with
  // width=0 and the screen-dimensions event may have already fired. Independent of
  // `streaming` (dimensions must be applied regardless). Apply last known size, else ask
  // the agent. Runs immediately then retries until the canvas is sized.
  useEffect(() => {
    if (!connected) return;
    const ensureSized = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width > 0) return true;
      const { width, height } = serverDimensionsRef.current || {};
      if (width > 0) handleCanvasDimensions({ width, height }, renderedTilesRef);
      else busRef.current?.emit("get-screen-dimensions");
      return false;
    };
    if (ensureSized()) return;
    const id = setInterval(() => { if (ensureSized()) clearInterval(id); }, REMOTE_CONFIG.restreamDelay);
    return () => clearInterval(id);
  }, [connected, busRef, canvasRef, serverDimensionsRef, handleCanvasDimensions, renderedTilesRef]);

  // Pause stream when tab hidden to save CPU + bandwidth
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onVisibility = () => {
      if (document.hidden) {
        bus.emit("stop-streaming");
      } else {
        // start-streaming alone clears checksums + pushes a full frame. Emitting
        // request-screen-with-hashes([]) here races the stream loop → black canvas.
        bus.emit("start-streaming");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [connected, busRef]);

  return {
    screenLocked,
    unlockReady,
    unlockResult,
    setUnlockResult,
    clipboardText,
    clipboardNew,
    setClipboardNew,
    monitors,
    activeMonitorIndex,
    cursorShape
  };
}
