"use client";

import { useRef, useCallback } from "react";
import { API_ENDPOINTS } from "@/shared/constants/api";
import { REMOTE_CONFIG } from "@/features/remote/constants/remote";


/**
 * Decode a single tile binary message from DataChannel.
 * Format: [20-byte header + N-byte JPEG]
 * Header: tileIndex(4) x(4) y(4) width(4) height(4)
 */
function decodeTileBinary(buffer) {
  const view = new DataView(buffer);
  const tileIndex = view.getUint32(0, true);
  const x = view.getUint32(4, true);
  const y = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const height = view.getUint32(16, true);
  const imageBuffer = buffer.slice(20);
  return { tileIndex, x, y, width, height, imageBuffer };
}

/**
 * Hook quản lý WebRTC peer connection với fallback chain:
 * STUN (P2P) → TURN (relay) → WS (Socket.IO)
 */
export function useWebRTC({ socketRef, apiKey, onFallback, onReady, onTilesData }) {
  const pcRef = useRef(null);
  const iceTimerRef = useRef(null);
  const dataChannelRef = useRef(null);
  // Batch buffer: collect tiles within one animation frame before flushing
  const tileBatchRef = useRef([]);
  const rafRef = useRef(null);

  const cleanup = useCallback(() => {
    clearTimeout(iceTimerRef.current);
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    tileBatchRef.current = [];
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  const fallback = useCallback(() => {
    console.warn("[WebRTC] ICE failed → fallback to WebSocket");
    cleanup();
    onFallback?.();
    // Notify settled as WS so pending startStreaming can proceed
    onReady?.("ws");
  }, [cleanup, onFallback, onReady]);

  const start = useCallback(async () => {
    cleanup();

    // Fetch TURN credentials từ worker (chỉ khi enableTurn = true)
    let iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    if (REMOTE_CONFIG.enableTurn) {
      try {
        const resp = await fetch(API_ENDPOINTS.turnCredentials, {
          headers: { "X-API-Key": apiKey }
        });
        if (resp.ok) {
          const data = await resp.json();
          iceServers = data.iceServers;
        }
      } catch (err) {
        console.warn("[WebRTC] Failed to fetch TURN credentials:", err.message);
      }
    }

    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;

    // DataChannel — server will send tiles via this channel
    const dc = pc.createDataChannel("tiles", { ordered: false, maxRetransmits: 0 });
    dataChannelRef.current = dc;

    dc.binaryType = "arraybuffer";

    dc.onopen = async () => {
      clearTimeout(iceTimerRef.current);
      // Detect if using TURN relay or direct P2P via ICE candidate stats
      let via = "dc";
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded") {
            const local = [...stats.values()].find(c => c.id === s.localCandidateId);
            if (local?.candidateType === "relay") via = "dc-turn";
            else via = "dc-stun";
          }
        });
      } catch {}
      console.log(`[WebRTC] DataChannel open — ${via === "dc-turn" ? "TURN relay" : "STUN P2P"}`);
      onReady?.(via);
    };

    dc.onclose = () => {
      console.warn("[WebRTC] DataChannel closed → fallback to WebSocket");
      onFallback?.();
    };

    // Receive binary tiles from server — 1 message = 1 tile, batch via rAF
    dc.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer)) return;
      try {
        const tile = decodeTileBinary(data);
        tileBatchRef.current.push(tile);
        // Flush all collected tiles in next animation frame (single render)
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const tiles = tileBatchRef.current;
            tileBatchRef.current = [];
            if (tiles.length > 0) onTilesData?.({ tiles, timestamp: Date.now() });
          });
        }
      } catch (err) {
        console.error("[WebRTC] decode tile error:", err.message);
      }
    };

    // Forward ICE candidates to server via signaling
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socketRef.current?.emit("webrtc:ice-candidate", {
          candidate: candidate.candidate,
          mid: candidate.sdpMid
        });
      }
    };

    // Monitor ICE state → fallback nếu failed
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log("[WebRTC] ICE state:", state);
      if (state === "failed") fallback();
    };

    // Nhận ICE candidate từ server
    socketRef.current?.on("webrtc:ice-candidate", ({ candidate, mid }) => {
      pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: mid })).catch(() => {});
    });

    // Nhận answer từ server
    socketRef.current?.on("webrtc:answer", async ({ sdp }) => {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      } catch (err) {
        console.error("[WebRTC] setRemoteDescription error:", err.message);
        fallback();
      }
    });

    // Nhận lỗi từ server
    socketRef.current?.on("webrtc:error", ({ message }) => {
      console.error("[WebRTC] server error:", message);
      fallback();
    });

    // Tạo offer gửi lên server
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("webrtc:offer", { sdp: offer.sdp });
    } catch (err) {
      console.error("[WebRTC] createOffer error:", err.message);
      fallback();
      return;
    }

    // No fallback timer needed — WS is already running as default transport
    // DC will upgrade when ready, or stay on WS if ICE fails
  }, [apiKey, socketRef, cleanup, fallback, onFallback, onReady, onTilesData]);

  const stop = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { start, stop, pcRef, dataChannelRef };
}
