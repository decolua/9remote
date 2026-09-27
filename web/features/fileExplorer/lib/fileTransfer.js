// Client-side file transfer: windowed upload + chunked download over the FILE
// channel (RTC preferred, WS fallback handled by ProtocolManager.sendBinary).
"use client";

import { CHANNELS, FILE_TRANSFER } from "@/shared/constants/transport";
import { encodeFileFrame, decodeFileFrame } from "@/shared/transport/fileFrame";
import { emitAck } from "@/features/mobile/hooks/useMobileDevices";
import { AckTracker } from "./ackTrackerWeb";
import { ConflictResolver } from "./conflict";

function planChunks(size, chunkSize) {
  if (size <= 0) return [];
  const out = [];
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunkSize, size - offset);
    out.push({ offset, length });
    offset += length;
  }
  return out;
}

/**
 * Upload a list of files into targetDir (preserving relativePath for folders).
 * @param {object} ctx
 * @param {object} ctx.bus  - the transport bus (carrier-agnostic)
 * @param {object} ctx.protocolRef - { current: ProtocolManager }
 * @param {string} ctx.targetDir
 * @param {Array<{file:File, relativePath:string}>} ctx.items
 * @param {object} ctx.callbacks - { onConflict(file,relativePath,exists)=>Promise<choice>, onProgress(file, ratio), onFileDone(file, status), onError(file, err) }
 *   onConflict returns one of: "skip" | "replace" | "skipAll" | "replaceAll"
 */
export async function uploadFiles({ bus, protocolRef, targetDir, items, callbacks }) {
  const { onConflict, onProgress, onFileDone, onError } = callbacks || {};
  const resolver = new ConflictResolver();

  for (const { file, relativePath } of items) {
    try {
      const result = await uploadOne(bus, protocolRef, targetDir, file, relativePath, resolver, onConflict, onProgress);
      onFileDone?.(file, result.status);
    } catch (e) {
      onError?.(file, e);
    }
  }
}

async function uploadOne(bus, protocolRef, targetDir, file, relativePath, resolver, onConflict, onProgress) {
  const start = await emitAck(bus, "upload:start", {
    targetDir, relativePath, size: file.size, mtime: file.lastModified || 0
  });
  if (!start.success) throw new Error(start.error);
  const { uploadId, exists } = start;

  if (exists) {
    let decision = resolver.resolve(true);
    if (decision === "ask") {
      const choice = await onConflict?.(file, relativePath);
      resolver.record(choice);
      decision = resolver.resolve(true);
    }
    if (decision === "skip") {
      bus.emit("upload:cancel", { uploadId });
      return { status: "skipped" };
    }
  }

  await streamFile(bus, protocolRef, uploadId, file, onProgress);
  return { status: "done" };
}

function streamFile(bus, protocolRef, uploadId, file, onProgress) {
  return new Promise(async (resolve, reject) => {
    const size = file.size;
    const chunkSize = FILE_TRANSFER.chunkSize;
    const windowBytes = chunkSize * FILE_TRANSFER.windowSize;

    let buf;
    try { buf = new Uint8Array(await file.arrayBuffer()); }
    catch (e) { reject(e); return; }

    const chunks = planChunks(size, chunkSize);
    let i = 0, sentOffset = 0, ackedOffset = 0, done = false;

    const onAck = ({ uploadId: uid, offset }) => {
      if (uid !== uploadId) return;
      if (offset > ackedOffset) {
        ackedOffset = offset;
        onProgress?.(file, size ? ackedOffset / size : 1);
      }
      if (ackedOffset >= size && !done) { done = true; bus.emit("upload:end", { uploadId }); }
      else pump();
    };
    const onErr = ({ uploadId: uid, error }) => {
      if (uid !== uploadId) return;
      cleanup();
      reject(new Error(error));
    };
    const onDoneEv = ({ uploadId: uid }) => {
      if (uid !== uploadId) return;
      cleanup();
      resolve();
    };
    function cleanup() {
      bus.off("upload:ack", onAck);
      bus.off("upload:error", onErr);
      bus.off("upload:done", onDoneEv);
    }
    bus.on("upload:ack", onAck);
    bus.on("upload:error", onErr);
    bus.on("upload:done", onDoneEv);

    const sendFrame = (frame) => {
      const pm = protocolRef?.current;
      if (pm?.sendBinary) return pm.sendBinary(CHANNELS.file, frame);
      bus.emit("file-bin", frame);
      return true;
    };

    function pump() {
      while (i < chunks.length && (sentOffset - ackedOffset) < windowBytes) {
        const c = chunks[i];
        const frame = encodeFileFrame(uploadId, c.offset, buf.subarray(c.offset, c.offset + c.length));
        if (!sendFrame(frame)) break; // backpressure — retry on next ack/tick
        i++;
        sentOffset = c.offset + c.length;
      }
      if (ackedOffset >= size && !done) {
        done = true;
        bus.emit("upload:end", { uploadId });
        return;
      }
      // Still chunks to send but sendBinary refused → short backoff keeps window full.
      if (i < chunks.length && (sentOffset - ackedOffset) < windowBytes) {
        setTimeout(pump, 50);
      }
    }
    pump();
  });
}

/**
 * Download a file/folder from host → client, assembling into a Blob.
 * Folder downloads arrive as a streamed .zip (size unknown up front).
 * @param {object} ctx - { bus, protocolRef, filePath, onSave(blob, meta), onProgress(ratio), onError(err) }
 * onSave receives a Blob + { size, fileName }; caller triggers the browser save.
 */
export function downloadFile({ bus, protocolRef: _protocolRef, filePath, onSave, onProgress, onError }) {
  let downloadId = null;
  let size = null;       // null = folder zip (size unknown until stream ends)
  let fileName = null;
  let tracker = null;
  let parts = null;

  const onFrame = (buffer) => {
    let frame;
    try { frame = decodeFileFrame(buffer); } catch { return; }
    if (frame.uploadId !== downloadId) return;
    parts.set(frame.offset, frame.payload);
    if (tracker) {
      tracker.mark(frame.offset, frame.payload.byteLength);
      if (onProgress && size) onProgress(tracker.watermark / size);
    }
  };
  const finalize = () => {
    cleanup();
    const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    onSave?.(new Blob(ordered), { size, fileName });
  };
  const onDoneEv = ({ downloadId: uid }) => {
    if (uid !== downloadId) return;
    // size-known: wait until all chunks in; folder zip: stream ended → ready.
    if (tracker && !tracker.isComplete()) return;
    finalize();
  };
  const onErrEv = ({ downloadId: uid, error }) => {
    if (uid !== downloadId) return;
    cleanup();
    onError?.(new Error(error));
  };
  function cleanup() {
    bus.off("file-bin", onFrame);
    bus.off("download:done", onDoneEv);
    bus.off("download:error", onErrEv);
  }

  emitAck(bus, "download:start", { filePath }).then((res) => {
    if (!res.success) { onError?.(new Error(res.error)); return; }
    downloadId = res.downloadId;
    size = res.size;              // null for folder zip
    fileName = res.fileName;
    tracker = size != null ? new AckTracker(size) : null;
    parts = new Map();
    bus.on("file-bin", onFrame);
    bus.on("download:done", onDoneEv);
    bus.on("download:error", onErrEv);
  }).catch((e) => onError?.(e));
}

/**
 * Stream a media file for progressive playback via MediaSource Extensions.
 * Frames arrive ordered (file DC is ordered, reliable) but may land before the
 * caller's SourceBuffer is open — caller must queue onChunk until ready.
 * Images: the host streams a server-scaled JPEG and the ack carries its dims
 * (width/height + originalWidth/originalHeight/scaled) alongside mime/size.
 * @param {object} ctx - { bus, filePath, onMeta(meta), onChunk(Uint8Array), onDone(), onError(err) }
 * @returns {Function} cancel()
 */
export function streamMedia({ bus, filePath, onMeta, onChunk, onDone, onError }) {
  let streamId = null;
  const pending = new Map(); // offset → payload (drain in order; guards reordering)
  let nextOffset = 0;

  const drain = () => {
    while (pending.has(nextOffset)) {
      const p = pending.get(nextOffset);
      pending.delete(nextOffset);
      onChunk?.(p);
      nextOffset += p.byteLength;
    }
  };
  const onFrame = (buffer) => {
    if (streamId == null) return;
    let frame;
    try { frame = decodeFileFrame(buffer); } catch { return; }
    if (frame.uploadId !== streamId) return;
    pending.set(frame.offset, frame.payload);
    drain();
  };
  const onDoneEv = ({ downloadId }) => {
    if (downloadId !== streamId) return;
    cleanup();
    onDone?.();
  };
  const onErrEv = ({ downloadId, error }) => {
    if (downloadId !== streamId) return;
    cleanup();
    onError?.(new Error(error));
  };
  function cleanup() {
    bus.off("file-bin", onFrame);
    bus.off("download:done", onDoneEv);
    bus.off("download:error", onErrEv);
  }

  // Register before the ack resolves so early frames buffer into `pending`.
  bus.on("file-bin", onFrame);
  bus.on("download:done", onDoneEv);
  bus.on("download:error", onErrEv);

  emitAck(bus, "streamMedia:start", { filePath }).then((res) => {
    if (!res.success) { cleanup(); onError?.(new Error(res.error)); return; }
    streamId = res.streamId;
    onMeta?.({
      mime: res.mime,
      size: res.size,
      width: res.width,
      height: res.height,
      scaled: res.scaled,
      originalWidth: res.originalWidth,
      originalHeight: res.originalHeight
    });
    drain();
  }).catch((e) => { cleanup(); onError?.(e); });

  return () => {
    cleanup();
    if (streamId != null) bus.emit("download:cancel", { downloadId: streamId });
  };
}

