"use client";

// Paints binary browser frames (file lane, self-tagged chunks) onto a canvas:
// reassemble → decode off the main thread → draw in ONE rAF → ack AFTER paint.
// The ack is the host's flow-control window release — acking on receipt (the
// old JSON path) let a slow decoder backlog frames; acking on paint paces the
// host to what the viewer actually shows.
//
// flags=1 payloads are remote-desktop tile batches (encodeTilesBatch wire
// format) — decoded by the SAME tileDecoder worker the remote canvas uses,
// then only the changed tile rects are drawn. flags=0 is one full JPEG.
import { useEffect, useRef, useState } from "react";
import { FrameAssembler } from "../lib/browserFrame.js";

// Shared decode worker (remote's) — one per pane, respawned if it dies.
let _tileWorker = null;
let _tileMsgId = 0;
const _tilePending = new Map();

function getTileWorker() {
  if (_tileWorker === false) return null;
  if (_tileWorker) return _tileWorker;
  try {
    _tileWorker = new Worker(
      new URL("../../remote/workers/tileDecoder.worker.js", import.meta.url)
    );
    _tileWorker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }) => {
      const resolve = _tilePending.get(id);
      if (!resolve) {
        if (tiles) for (const t of tiles) t.bitmap?.close?.();
        return;
      }
      _tilePending.delete(id);
      resolve(error ? null : { tiles, timestamp, hasBitmap });
    };
  } catch {
    _tileWorker = false;
    return null;
  }
  return _tileWorker;
}

function decodeTileBatch(buffer) {
  const worker = getTileWorker();
  if (!worker) return Promise.resolve(null);
  const id = ++_tileMsgId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _tilePending.delete(id); resolve(null); }, 4000);
    _tilePending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    worker.postMessage({ buffer, id, v: 2 }, [buffer]);
  }).then((result) => {
    if (!result) _tileWorker = null; // died/stalled — respawn on next batch
    return result;
  });
}

async function decodeJpeg(payload) {
  const blob = new Blob([payload], { type: "image/jpeg" });
  if (typeof createImageBitmap !== "undefined") {
    return createImageBitmap(blob).catch(() => null);
  }
  // Old Safari: decode via an off-DOM <img>, draw it directly.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useBrowserFrame({ busRef, connected, targetId, onPainted }) {
  const canvasRef = useRef(null);
  // { meta, w, h } — gates overlays/loading; the pixels live on the canvas.
  const [frame, setFrame] = useState(null);
  const frameRef = useRef(null);
  const rafRef = useRef(0);
  // One paint batch: full frame OR a map of tileIndex → tile (newest wins).
  const queuedRef = useRef(null);
  const onPaintedRef = useRef(onPainted);
  useEffect(() => { onPaintedRef.current = onPainted; }, [onPainted]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.on || !targetId) return;
    const asm = new FrameAssembler();
    let stopped = false;
    let canvasW = 0, canvasH = 0;

    const ensureSize = (w, h) => {
      const canvas = canvasRef.current;
      if (!canvas) return false;
      if (canvasW !== w || canvasH !== h) {
        canvas.width = w;
        canvas.height = h;
        canvasW = w;
        canvasH = h;
      }
      return true;
    };

    const paint = () => {
      rafRef.current = 0;
      const queued = queuedRef.current;
      const canvas = canvasRef.current;
      if (!queued || !canvas) return;
      queuedRef.current = null;
      const ctx = canvas.getContext("2d");
      let bytes = 0;
      // An unpainted full frame kept as the base: tiles newer than it must
      // land ON it, not on a blank canvas.
      if (queued.base) {
        if (!ensureSize(queued.base.width, queued.base.height)) return;
        ctx.drawImage(queued.base, 0, 0);
        queued.base.close?.();
        bytes += queued.baseBytes || 0;
      }
      if (queued.kind === "full") {
        if (!ensureSize(queued.source.width, queued.source.height)) return;
        ctx.drawImage(queued.source, 0, 0);
        bytes += queued.bytes;
        queued.source.close?.();
        frameRef.current = queued.frame;
        setFrame(queued.frame);
      } else {
        // Partial: only the changed tile rects — the rest of the canvas persists.
        for (const tile of queued.tiles.values()) {
          ctx.drawImage(tile.bitmap, tile.x, tile.y, tile.width, tile.height);
          bytes += tile.bytes;
          tile.bitmap.close?.();
        }
        if (queued.frame) {
          frameRef.current = queued.frame;
          setFrame(queued.frame);
        }
      }
      // Ack only now — the frame is on screen, the host may send the next one.
      bus.emit?.("browser:stream.ack", { targetId, seq: queued.seq });
      onPaintedRef.current?.(queued.frame?.meta, bytes);
    };

    const schedulePaint = (queued) => {
      // A queued-but-unpainted batch is already superseded — merge instead of
      // painting it: tile batches union per index, and an unpainted full frame
      // becomes the base under newer tiles.
      const prev = queuedRef.current;
      if (prev) {
        if (prev.kind === "full") {
          queued.base = prev.source;
          queued.baseBytes = prev.bytes;
        } else if (queued.kind === "tiles") {
          for (const [idx, t] of prev.tiles) {
            if (!queued.tiles.has(idx)) queued.tiles.set(idx, t);
          }
        } else {
          // Newer full frame beats pending tiles outright.
          for (const t of prev.tiles.values()) t.bitmap.close?.();
        }
      }
      queuedRef.current = queued;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
    };

    const onBinary = (buffer) => {
      if (stopped) return;
      const done = asm.push(buffer);
      if (!done || done.targetId !== targetId) return;
      if (done.flags === 1) {
        void decodeTileBatch(done.payload.buffer.slice(done.payload.byteOffset, done.payload.byteOffset + done.payload.byteLength)).then((result) => {
          if (stopped || !result?.tiles?.length) return;
          const tiles = new Map();
          for (const t of result.tiles) {
            if (!t.bitmap) continue;
            tiles.set(t.tileIndex, { bitmap: t.bitmap, x: t.x, y: t.y, width: t.width, height: t.height, bytes: 0 });
          }
          if (!tiles.size) return;
          const frameInfo = done.meta.frameW ? { meta: done.meta, w: done.meta.frameW, h: done.meta.frameH } : null;
          schedulePaint({ kind: "tiles", tiles, seq: done.seq, frame: frameInfo });
        });
        return;
      }
      void decodeJpeg(done.payload).then((source) => {
        if (stopped || !source) return;
        schedulePaint({
          kind: "full", source, seq: done.seq, bytes: done.payload.byteLength,
          frame: { meta: done.meta, w: source.width, h: source.height }
        });
      });
    };

    bus.on?.("file-bin", onBinary);
    return () => {
      stopped = true;
      bus.off?.("file-bin", onBinary);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued?.base) queued.base.close?.();
      if (queued?.kind === "full") queued.source.close?.();
      else if (queued) for (const t of queued.tiles.values()) t.bitmap.close?.();
      canvasW = 0;
      canvasH = 0;
    };
  }, [busRef, connected, targetId]);

  return { canvasRef, frame, frameRef };
}
