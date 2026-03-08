"use client";

import { useRef, useCallback, useState } from "react";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

/**
 * Base DataChannel hook — mirrors useBaseSocket interface.
 *
 * Wraps RTCPeerConnection + DataChannel lifecycle:
 *   - Fetches TURN credentials (optional)
 *   - Creates offer → sends via socketRef signaling
 *   - Receives answer + ICE candidates via socket events
 *   - Exposes onConnect / onDisconnect / onMessage callbacks
 *   - Cleans up ALL socket listeners on stop (no leak)
 *
 * Interface intentionally mirrors useBaseSocket so consumers
 * can treat DataChannel the same as a Socket.IO socket.
 */
export function useBaseDataChannel({ socketRef, apiKey, enableTurn, onConnect, onDisconnect, onMessage }) {
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const [connected, setConnected] = useState(false);

  // Stable named handlers stored in refs so we can off() them precisely
  const iceCandidateHandlerRef = useRef(null);
  const answerHandlerRef = useRef(null);
  const errorHandlerRef = useRef(null);

  // Remove all socket signaling listeners — prevents any leak
  const removeSignalingListeners = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    if (iceCandidateHandlerRef.current) {
      socket.off("webrtc:ice-candidate", iceCandidateHandlerRef.current);
      iceCandidateHandlerRef.current = null;
    }
    if (answerHandlerRef.current) {
      socket.off("webrtc:answer", answerHandlerRef.current);
      answerHandlerRef.current = null;
    }
    if (errorHandlerRef.current) {
      socket.off("webrtc:error", errorHandlerRef.current);
      errorHandlerRef.current = null;
    }
  }, [socketRef]);

  const cleanup = useCallback(() => {
    removeSignalingListeners();
    if (dcRef.current) {
      dcRef.current.onopen = null;
      dcRef.current.onclose = null;
      dcRef.current.onerror = null;
      dcRef.current.onmessage = null;
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    setConnected(false);
  }, [removeSignalingListeners]);

  const start = useCallback(async () => {
    cleanup();

    // Fetch TURN credentials if enabled
    let iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    if (enableTurn) {
      try {
        const resp = await fetch(API_ENDPOINTS.turnCredentials, {
          headers: { "X-API-Key": apiKey }
        });
        if (resp.ok) {
          const data = await resp.json();
          iceServers = data.iceServers;
        }
      } catch (err) {
        console.warn("[DataChannel] Failed to fetch TURN credentials:", err.message);
      }
    }

    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;

    // DataChannel — reliability mode from config
    const dc = pc.createDataChannel("tiles", { 
      ordered: REMOTE_CONFIG.dcOrdered, 
      maxRetransmits: REMOTE_CONFIG.dcReliable ? undefined : 0 
    });
    dc.binaryType = "arraybuffer";
    dcRef.current = dc;

    dc.onopen = async () => {
      // Detect transport type via ICE candidate stats
      let via = "dc-stun";
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded") {
            const local = [...stats.values()].find((c) => c.id === s.localCandidateId);
            if (local?.candidateType === "relay") via = "dc-turn";
          }
        });
      } catch {}
      setConnected(true);
      // Pass dc instance so caller (useWebRTC) can attach it to transport
      onConnect?.(via, dc);
    };

    dc.onclose = () => {
      setConnected(false);
      onDisconnect?.("dc-closed");
    };

    dc.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      // User-initiated abort is expected on manual disconnect — skip noisy log
      if (msg.includes("User-Initiated")) return;
      console.error("[DataChannel] error:", msg);
    };

    dc.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) onMessage?.(data);
    };

    // Forward local ICE candidates to server via socket signaling
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socketRef.current?.emit("webrtc:ice-candidate", {
          candidate: candidate.candidate,
          mid: candidate.sdpMid
        });
      }
    };

    // Fallback → trigger onDisconnect when ICE fails
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "failed") {
        cleanup();
        onDisconnect?.("ice-failed");
      }
    };

    // Register signaling listeners with named functions so they can be off()'d
    const onIceCandidate = ({ candidate, mid }) => {
      pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: mid })).catch(() => {});
    };
    const onAnswer = async ({ sdp }) => {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      } catch (err) {
        console.error("[DataChannel] setRemoteDescription error:", err.message);
        cleanup();
        onDisconnect?.("sdp-error");
      }
    };
    const onError = ({ message }) => {
      console.error("[DataChannel] server error:", message);
      cleanup();
      onDisconnect?.("server-error");
    };

    iceCandidateHandlerRef.current = onIceCandidate;
    answerHandlerRef.current = onAnswer;
    errorHandlerRef.current = onError;

    const socket = socketRef.current;
    socket?.on("webrtc:ice-candidate", onIceCandidate);
    socket?.on("webrtc:answer", onAnswer);
    socket?.on("webrtc:error", onError);

    // Create and send offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit("webrtc:offer", { sdp: offer.sdp });
    } catch (err) {
      console.error("[DataChannel] createOffer error:", err.message);
      cleanup();
      onDisconnect?.("offer-error");
    }
  }, [apiKey, enableTurn, socketRef, cleanup, onConnect, onDisconnect, onMessage]);

  const stop = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return { start, stop, pcRef, dcRef, connected };
}
