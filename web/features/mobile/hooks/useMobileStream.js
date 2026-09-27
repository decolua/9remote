"use client";

// Receives chunked H.264 access units off the transport bus, reassembles them,
// and paints via WebCodecs. The canvas is sized by the host's stream meta, so
// device rotation arrives as a new meta rather than a resize guess.

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeMobileFrame } from "../lib/mobileFrame";
import { buildCodecString, scanAccessUnit } from "../lib/h264";
import {
  FRAME_QUEUE_SIZE, DECODE_QUEUE_LIMIT, REASSEMBLY_WINDOW, KEYFRAME_REQUEST_INTERVAL_MS
} from "../constants/mobileConfig";

export const DECODER_SUPPORTED =
  typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window;

export function useMobileStream({ busRef, connected, canvasRef, meta }) {
  const [status, setStatus] = useState("idle");
  const [fps, setFps] = useState(0);
  const stateRef = useRef(null);

  const requestKeyframe = useCallback(() => {
    const st = stateRef.current;
    const now = performance.now();
    if (st && now - st.lastKeyframeReq < KEYFRAME_REQUEST_INTERVAL_MS) return;
    if (st) st.lastKeyframeReq = now;
    busRef?.current?.emit("mobile:keyframe");
  }, [busRef]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected || !meta || !DECODER_SUPPORTED) return;

    const st = {
      decoder: null,
      pending: new Map(),      // frameSeq → {chunks, received, count, isKey, isConfig, ptsMs}
      queue: [],
      raf: 0,
      sawKey: false,
      dropping: false,
      lastKeyframeReq: 0,
      ackedSeq: -1,
      config: null,           // SPS/PPS bytes — sent once, needed before every IDR
      frameCount: 0,
      fpsAt: performance.now()
    };
    stateRef.current = st;
    setStatus("connecting");

    const closeDecoder = () => {
      if (st.decoder && st.decoder.state !== "closed") {
        try { st.decoder.close(); } catch { /* already closing */ }
      }
      st.decoder = null;
      st.sawKey = false;
      for (const f of st.queue) f.close();
      st.queue = [];
    };

    const paint = () => {
      st.raf = 0;
      const canvas = canvasRef.current;
      // Burst of decoded frames: only the newest reflects where the screen is
      // now; closing the rest keeps latency from accumulating.
      while (st.queue.length > 1) st.queue.shift()?.close();
      const frame = st.queue.shift();
      if (!frame) return;
      const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
      if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();

      st.frameCount++;
      const now = performance.now();
      if (now - st.fpsAt >= 1000) {
        setFps(Math.round((st.frameCount * 1000) / (now - st.fpsAt)));
        st.frameCount = 0;
        st.fpsAt = now;
      }
      if (st.queue.length) st.raf = requestAnimationFrame(paint);
    };

    // Decoder fell behind: stop feeding deltas and resume at the next keyframe
    // WITHOUT closing the decoder — closing blanks the canvas mid-scroll and
    // reads as a flash. A keyframe re-inits the reference chain, so the open
    // decoder picks straight back up.
    const skipToKeyframe = () => {
      st.dropping = true;
      requestKeyframe();
    };
    // Only a real decoder error justifies tearing it down.
    const recover = () => {
      closeDecoder();
      st.dropping = true;
      requestKeyframe();
    };

    const ensureDecoder = (spsBytes) => {
      if (st.decoder?.state === "configured") return true;
      closeDecoder();
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (st.decoder !== decoder) { frame.close(); return; }
          if (st.queue.length >= FRAME_QUEUE_SIZE) st.queue.shift()?.close();
          st.queue.push(frame);
          if (!st.raf) st.raf = requestAnimationFrame(paint);
        },
        error: () => { if (st.decoder === decoder) recover(); }
      });
      try {
        decoder.configure({ codec: buildCodecString(spsBytes), optimizeForLatency: true });
        st.decoder = decoder;
        return true;
      } catch {
        try { decoder.close(); } catch { /* never configured */ }
        setStatus("decoder failed");
        requestKeyframe();
        return false;
      }
    };

    const feed = ({ data: au, isKey, isConfig, ptsMs }) => {
      let data = au;
      // scrcpy sends SPS/PPS as its own packet, ahead of the keyframe that needs
      // them. Keep the bytes: WebCodecs wants them in-band before every IDR.
      if (isConfig) {
        st.config = data;
        const sps = scanAccessUnit(data).spsBytes;
        if (sps) ensureDecoder(sps);
        return;
      }
      if (isKey && st.decoder?.state !== "configured") {
        // Decoder is not up and the config packet has not arrived — a keyframe
        // alone cannot configure it, so ask for a fresh one and wait.
        if (!st.config) { requestKeyframe(); return; }
        const sps = scanAccessUnit(st.config).spsBytes;
        if (!sps || !ensureDecoder(sps)) return;
      }
      // Prepend the config to each IDR so a mid-stream decoder reset can recover.
      if (isKey && st.config) {
        const merged = new Uint8Array(st.config.byteLength + data.byteLength);
        merged.set(st.config, 0);
        merged.set(data, st.config.byteLength);
        data = merged;
      }

      if (st.dropping) {
        if (!isKey || st.decoder?.state !== "configured") { requestKeyframe(); return; }
        st.dropping = false;
      }
      if (st.decoder?.state !== "configured") { if (!isKey) requestKeyframe(); return; }
      if (st.decoder.decodeQueueSize > DECODE_QUEUE_LIMIT) { skipToKeyframe(); return; }
      if (!st.sawKey) {
        if (!isKey) { requestKeyframe(); return; }
        st.sawKey = true;
        setStatus("streaming");
      }
      try {
        st.decoder.decode(new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: ptsMs * 1000,
          data
        }));
      } catch {
        recover();
      }
    };

    // Tell the host a frame has fully arrived so it can send the next one. It
    // waits on this: without it the pump runs at encoder speed and a slow
    // tunnel accumulates a backlog instead of simply dropping to fewer frames.
    // Coalesced to one emit per frame, and only for the newest seq — the
    // channel is ordered, so acking N covers everything before it.
    const ack = (seq) => {
      if (seq <= st.ackedSeq) return;
      st.ackedSeq = seq;
      bus.emit("mobile:ack", { seq });
    };

    const onBinary = (buffer) => {
      const chunk = decodeMobileFrame(buffer);
      if (!chunk) return; // a file-transfer frame sharing this channel

      if (chunk.chunkCount === 1) {
        ack(chunk.frameSeq);
        feed({ data: chunk.payload, isKey: chunk.isKey, isConfig: chunk.isConfig, ptsMs: chunk.ptsMs });
        return;
      }
      let entry = st.pending.get(chunk.frameSeq);
      if (!entry) {
        entry = { chunks: new Array(chunk.chunkCount), received: 0, count: chunk.chunkCount, isKey: chunk.isKey, isConfig: chunk.isConfig, ptsMs: chunk.ptsMs };
        st.pending.set(chunk.frameSeq, entry);
        // Ordered channel: anything still open beyond the window lost a chunk.
        for (const seq of st.pending.keys()) {
          if (chunk.frameSeq - seq > REASSEMBLY_WINDOW) st.pending.delete(seq);
        }
      }
      if (entry.chunks[chunk.chunkIdx]) return;
      entry.chunks[chunk.chunkIdx] = chunk.payload;
      entry.received++;
      if (entry.received !== entry.count) return;

      st.pending.delete(chunk.frameSeq);
      ack(chunk.frameSeq);
      const size = entry.chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(size);
      let at = 0;
      for (const c of entry.chunks) { data.set(c, at); at += c.byteLength; }
      feed({ data, isKey: entry.isKey, isConfig: entry.isConfig, ptsMs: entry.ptsMs });
    };

    const onEnded = () => setStatus("ended");

    // video arrives on its own lane; file-bin stays as the legacy/fallback lane.
    bus.on("mobile-bin", onBinary);
    bus.on("file-bin", onBinary);
    bus.on("mobile:ended", onEnded);
    requestKeyframe();

    return () => {
      bus.off("mobile-bin", onBinary);
      bus.off("file-bin", onBinary);
      bus.off("mobile:ended", onEnded);
      if (st.raf) cancelAnimationFrame(st.raf);
      closeDecoder();
      st.pending.clear();
      stateRef.current = null;
    };
  }, [busRef, connected, canvasRef, meta, requestKeyframe]);

  // A hidden tab still holds the bus and still acks, so the host has no way
  // to tell nobody is watching. Say so explicitly, and ask for a keyframe on the
  // way back since the paused stream left a gap.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected || !meta) return;
    const onVisibility = () => {
      const visible = !document.hidden;
      bus.emit("mobile:visible", { visible });
      if (visible) requestKeyframe();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Always state the current value on mount, never only the hidden case: this
    // effect is re-run whenever the mirror moves between float and pinned, and a
    // remount that only reported "hidden" would leave the host paused forever.
    bus.emit("mobile:visible", { visible: !document.hidden });
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [busRef, connected, meta, requestKeyframe]);

  return { status: DECODER_SUPPORTED ? status : "unsupported", fps, requestKeyframe };
}
