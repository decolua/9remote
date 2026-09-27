// Per-socket file transfer manager. Owns upload write-streams and download
// read-streams, decodes binary frames, enforces path safety + size caps, and
// preserves mtime. Uploads open their write stream lazily (on first chunk) so a
// conflicted file is NOT truncated when the user picks Skip.
import fs from "fs";
import path from "path";
import { Writable } from "stream";
import archiver from "archiver";
import { CHANNELS, FILE_TRANSFER } from "../../../lib/transportConstants.js";
import { encodeFileFrame, decodeFileFrame } from "../../../transport/fileFrame.js";
import { AckTracker } from "./ackTracker.js";
import { planChunks } from "./chunkPlan.js";
import { resolveSafePath } from "./sanitize.js";
import { isSensitivePath } from "../pathGuard.js";
import { getMimeType, isStreamScalableImage, isHeicFile, MAX_IMAGE_RAW_SIZE } from "../constants.js";
import { scaleImageBuffer } from "../handlers/FileHandler.js";

let _idSeq = 1;

// Sum of all file sizes under a directory (ignores symlink loops, skips unreadable).
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch {} }
    }
  }
  return total;
}

export class TransferManager {
  constructor(socket) {
    this.socket = socket;
    this._uploads = new Map();   // uploadId → { targetPath, size, mtime, tracker, ws }
    this._downloads = new Map(); // downloadId → { stream }
  }

  get _pm() {
    return this.socket.data?.protocol;
  }

  // ── Upload (client → agent) ──────────────────────────────────────────────

  startUpload({ targetDir, relativePath, size, mtime }, cb) {
    try {
      if (!Number.isFinite(size) || size < 0) return cb?.({ success: false, error: "Invalid size" });
      if (size > FILE_TRANSFER.maxUploadSize) {
        return cb?.({ success: false, error: `File too large (max ${FILE_TRANSFER.maxUploadSize} bytes)` });
      }
      const targetPath = resolveSafePath(targetDir, relativePath);
      if (isSensitivePath(targetPath)) return cb?.({ success: false, error: "Access denied" });
      const exists = fs.existsSync(targetPath);
      const uploadId = _idSeq++;
      // Lazy: stream opened on first chunk so Skip doesn't truncate an existing file.
      this._uploads.set(uploadId, { targetPath, size, mtime, tracker: new AckTracker(size), ws: null });
      cb?.({ success: true, uploadId, exists });
    } catch (e) {
      cb?.({ success: false, error: e.message });
    }
  }

  // Called for every "file-bin" buffer (WS native + RTC routed via PM._onBinary).
  handleBinary(buffer) {
    let frame;
    try { frame = decodeFileFrame(buffer); }
    catch { return; }
    const up = this._uploads.get(frame.uploadId);
    if (!up) return;
    // Reject chunks beyond the declared size — otherwise a client could declare a
    // small file then stream unbounded bytes (cap bypass / disk fill).
    const end = frame.offset + frame.payload.byteLength;
    if (end > up.size) {
      this._failUpload(frame.uploadId, "Chunk exceeds declared file size");
      return;
    }
    if (!up.ws) {
      // First chunk — open stream now (truncate-on-write, intended for Replace).
      try { fs.mkdirSync(path.dirname(up.targetPath), { recursive: true }); }
      catch (e) { this._failUpload(frame.uploadId, e.message); return; }
      try { up.ws = fs.createWriteStream(up.targetPath); }
      catch (e) { this._failUpload(frame.uploadId, e.message); return; }
      up.ws.on("error", (e) => this._failUpload(frame.uploadId, e.message));
    }
    up.ws.write(Buffer.from(frame.payload));
    const advanced = up.tracker.mark(frame.offset, frame.payload.byteLength);
    if (advanced != null) {
      this.socket.emit("upload:ack", { uploadId: frame.uploadId, offset: advanced });
    }
    if (up.tracker.isComplete()) this._finalizeUpload(frame.uploadId);
  }

  endUpload({ uploadId }, cb) {
    const up = this._uploads.get(uploadId);
    if (!up) return cb?.({ success: false, error: "Unknown upload" });
    // 0-byte file: no chunks arrive so the write stream was never opened lazily.
    // Create the empty file now (mkdir parents) and finalize directly.
    if (!up.ws) {
      try {
        fs.mkdirSync(path.dirname(up.targetPath), { recursive: true });
        fs.writeFileSync(up.targetPath, Buffer.alloc(0));
      } catch (e) {
        this._failUpload(uploadId, e.message);
        return cb?.({ success: false, error: e.message });
      }
      if (up.mtime != null) {
        try { const t = up.mtime / 1000; fs.utimesSync(up.targetPath, t, t); } catch {}
      }
      this.socket.emit("upload:done", { uploadId, path: up.targetPath });
      this._uploads.delete(uploadId);
      return cb?.({ success: true });
    }
    if (up.tracker.isComplete()) this._finalizeUpload(uploadId);
    cb?.({ success: true });
  }

  cancelUpload({ uploadId }, cb) {
    const up = this._uploads.get(uploadId);
    if (!up) return cb?.({ success: true });
    try { up.ws?.destroy(); } catch {}
    // If we never wrote (lazy, no stream), the target is untouched.
    this._uploads.delete(uploadId);
    cb?.({ success: true });
  }

  _finalizeUpload(uploadId) {
    const up = this._uploads.get(uploadId);
    if (!up || !up.ws) return;
    const finish = () => {
      if (up.mtime != null) {
        try { const t = up.mtime / 1000; fs.utimesSync(up.targetPath, t, t); } catch {}
      }
      this.socket.emit("upload:done", { uploadId, path: up.targetPath });
      this._uploads.delete(uploadId);
    };
    if (up.ws.writableEnded) { finish(); return; }
    up.ws.end(finish);
  }

  _failUpload(uploadId, error) {
    const up = this._uploads.get(uploadId);
    try { up?.ws?.destroy(); } catch {}
    this._uploads.delete(uploadId);
    this.socket.emit("upload:error", { uploadId, error });
  }

  // ── Download (agent → client) ────────────────────────────────────────────

  startDownload({ filePath }, cb) {
    try {
      if (isSensitivePath(filePath)) return cb?.({ success: false, error: "Access denied" });
      if (!fs.existsSync(filePath)) return cb?.({ success: false, error: "Not found" });
      const stat = fs.statSync(filePath);
      const downloadId = _idSeq++;
      if (stat.isDirectory()) {
        const sum = dirSize(filePath);
        if (sum > FILE_TRANSFER.maxDownloadSize) {
          return cb?.({ success: false, error: `Folder too large (${sum} bytes). Max ${FILE_TRANSFER.maxDownloadSize}. Download files individually.` });
        }
        cb?.({ success: true, downloadId, size: null, fileName: path.basename(filePath) + ".zip" });
        this._streamZip(downloadId, filePath);
      } else {
        if (!stat.isFile()) return cb?.({ success: false, error: "Not a file" });
        if (stat.size > FILE_TRANSFER.maxUploadSize) {
          return cb?.({ success: false, error: `File too large (max ${FILE_TRANSFER.maxUploadSize} bytes)` });
        }
        cb?.({ success: true, downloadId, size: stat.size, fileName: path.basename(filePath), mtime: stat.mtimeMs });
        this._streamDownload(downloadId, filePath, stat.size);
      }
    } catch (e) {
      cb?.({ success: false, error: e.message });
    }
  }

  // Stream a media file for progressive playback (MSE on the client) over FILE
  // frames. Reuses _streamDownload — only the entry validation differs: a higher
  // cap (media is streamed, not held in memory on either side) + MIME in the ack.
  // Static raster images take the scaled branch instead: the client decodes the
  // bytes into a full-resolution bitmap, and a modern photo is more RAM than a
  // phone's web process is allowed — WebKit kills the page.
  startStreamMedia({ filePath }, cb) {
    try {
      if (isSensitivePath(filePath)) return cb?.({ success: false, error: "Access denied" });
      if (!fs.existsSync(filePath)) return cb?.({ success: false, error: "Not found" });
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return cb?.({ success: false, error: "Not a file" });
      if (isStreamScalableImage(filePath)) return this._startScaledImage(filePath, stat, cb);
      if (stat.size > FILE_TRANSFER.maxStreamMediaSize) {
        return cb?.({ success: false, error: `File too large (max ${FILE_TRANSFER.maxStreamMediaSize} bytes)` });
      }
      const streamId = _idSeq++;
      cb?.({ success: true, streamId, size: stat.size, mime: getMimeType(filePath) });
      this._streamDownload(streamId, filePath, stat.size);
    } catch (e) {
      cb?.({ success: false, error: e.message });
    }
  }

  // Scale server-side (same pipeline readMedia uses) and stream the bounded
  // JPEG. Ack carries the scaled + original dims so the client toolbar can show
  // both without decoding anything itself.
  async _startScaledImage(filePath, stat, cb) {
    try {
      if (stat.size > MAX_IMAGE_RAW_SIZE) {
        return cb?.({ success: false, error: `Image too large (max ${MAX_IMAGE_RAW_SIZE} bytes)` });
      }
      // HEIC is decoded from the path by a system tool — no point reading it here.
      const raw = isHeicFile(filePath) ? null : fs.readFileSync(filePath);
      const scaled = await scaleImageBuffer(raw, filePath);
      const streamId = _idSeq++;
      cb?.({
        success: true,
        streamId,
        size: stat.size,
        mime: "image/jpeg",
        width: scaled.width,
        height: scaled.height,
        originalWidth: scaled.originalWidth,
        originalHeight: scaled.originalHeight,
        scaled: scaled.buffer.length < stat.size
      });
      this._streamBuffer(streamId, scaled.buffer);
    } catch (e) {
      cb?.({ success: false, error: e.message });
    }
  }

  // Zip a folder on the fly and stream the archive bytes as FILE frames.
  // size is unknown up front (compression) — client assembles via download:done.
  _streamZip(downloadId, dirPath) {
    const pm = this._pm;
    let offset = 0, cancelled = false;
    const archive = archiver("zip", { zlib: { level: 1 } }); // level 1 = fast

    const sender = new Writable({
      write(chunk, _enc, callback) {
        const sendFrame = () => {
          if (cancelled) return callback(new Error("cancelled"));
          const frame = encodeFileFrame(downloadId, offset, chunk);
          const ok = pm?.sendBinary(CHANNELS.file, frame);
          if (ok) { offset += chunk.length; callback(); }
          else setTimeout(sendFrame, 50); // backpressure — retry
        };
        sendFrame();
      }
    });

    this._downloads.set(downloadId, {
      archive,
      cancel: () => { cancelled = true; try { archive.destroy(); } catch {} }
    });

    archive.on("error", (e) => {
      this.socket.emit("download:error", { downloadId, error: e.message });
      this._downloads.delete(downloadId);
    });
    // sender 'finish' = all archive bytes written + sent as frames (each write
    // callback fires after sendBinary ok). Fires reliably; archiver 'end' does not.
    sender.on("finish", () => {
      this.socket.emit("download:done", { downloadId });
      this._downloads.delete(downloadId);
    });
    sender.on("error", (e) => {
      this.socket.emit("download:error", { downloadId, error: e.message });
      this._downloads.delete(downloadId);
    });
    archive.pipe(sender);
    archive.directory(dirPath, path.basename(dirPath));
    archive.finalize();
  }

  // Stream an in-memory buffer as FILE frames — same backpressure + done
  // contract as _streamDownload, for already-transformed payloads.
  _streamBuffer(downloadId, buffer) {
    const pm = this._pm;
    let offset = 0;
    let cancelled = false;
    this._downloads.set(downloadId, { cancel: () => { cancelled = true; } });

    const sendNext = () => {
      while (offset < buffer.length) {
        const chunk = buffer.subarray(offset, offset + FILE_TRANSFER.chunkSize);
        const ok = pm?.sendBinary(CHANNELS.file, encodeFileFrame(downloadId, offset, chunk));
        if (!ok) {
          // Backpressure (RTC buffer full / WS not writable) — retry shortly.
          setTimeout(() => { if (!cancelled) sendNext(); }, 50);
          return;
        }
        offset += chunk.length;
      }
      this.socket.emit("download:done", { downloadId });
      this._downloads.delete(downloadId);
    };
    sendNext();
  }

  _streamDownload(downloadId, filePath, size) {
    const pm = this._pm;
    const stream = fs.createReadStream(filePath, { highWaterMark: FILE_TRANSFER.chunkSize });
    this._downloads.set(downloadId, { stream });
    let offset = 0;
    let cancelled = false;

    const sendOne = (chunk) => {
      const frame = encodeFileFrame(downloadId, offset, chunk);
      const ok = pm?.sendBinary(CHANNELS.file, frame);
      if (ok) {
        offset += chunk.length;
        stream.resume();
      } else {
        // Backpressure (RTC buffer full / WS not writable) — retry shortly.
        setTimeout(() => { if (!cancelled) sendOne(chunk); }, 50);
      }
    };

    stream.on("data", (chunk) => {
      stream.pause();
      sendOne(chunk);
    });
    stream.on("end", () => {
      this.socket.emit("download:done", { downloadId });
      this._downloads.delete(downloadId);
    });
    stream.on("error", (e) => {
      this.socket.emit("download:error", { downloadId, error: e.message });
      this._downloads.delete(downloadId);
    });

    this._downloads.get(downloadId).cancel = () => { cancelled = true; };
  }

  cancelDownload({ downloadId }, cb) {
    const d = this._downloads.get(downloadId);
    if (d) {
      d.cancel?.();
      try { d.stream?.destroy(); } catch {}
      try { d.archive?.destroy(); } catch {}
      this._downloads.delete(downloadId);
    }
    cb?.({ success: true });
  }

  cleanup() {
    for (const up of this._uploads.values()) { try { up.ws?.destroy(); } catch {} }
    for (const d of this._downloads.values()) {
      d.cancel?.();
      try { d.stream?.destroy(); } catch {}
      try { d.archive?.destroy(); } catch {}
    }
    this._uploads.clear();
    this._downloads.clear();
  }
}
