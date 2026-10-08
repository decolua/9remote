// Binary framing for browser stream frames over the transport's ordered "file"
// channel. Mirrored verbatim in host/features/browser/browserFrame.js —
// change both sides together.
//
// A JPEG frame can exceed the SCTP message cap, so it is split into chunks the
// client reassembles by seq. Layout (big-endian):
//   [magic u32][seq u32][chunkIdx u16][chunkCount u16][targetIdLen u8][reserved u8][metaLen u16][targetId][meta JSON][payload]
//
// magic reuses the file channel's uploadId slot with a value the file-transfer
// id sequence never reaches (mobile video uses 0xffffffff), so browser frames,
// mobile video and file chunks share one channel without a transport change.
export const BROWSER_FRAME_MAGIC = 0xfefefefe;
export const BROWSER_HEADER_SIZE = 16;
export const BROWSER_META_MAX_BYTES = 512;
// Half-finished frames older than this many seqs get evicted (lost chunk).
const ASSEMBLER_MAX_PENDING = 16;

/** Returns null when the buffer is not a browser frame (a file/mobile chunk). */
export function decodeBrowserFrame(buf) {
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (view.byteLength < BROWSER_HEADER_SIZE) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint32(0) !== BROWSER_FRAME_MAGIC) return null;
  const idLen = dv.getUint8(12);
  const metaLen = dv.getUint16(14);
  const metaAt = BROWSER_HEADER_SIZE + idLen;
  if (metaAt + metaLen > view.byteLength) return null;
  let meta = {};
  if (metaLen > 0 && metaLen <= BROWSER_META_MAX_BYTES) {
    try { meta = JSON.parse(new TextDecoder().decode(view.subarray(metaAt, metaAt + metaLen))); } catch { meta = {}; }
  }
  return {
    seq: dv.getUint32(4),
    chunkIdx: dv.getUint16(8),
    chunkCount: dv.getUint16(10),
    flags: dv.getUint8(13),
    targetId: new TextDecoder().decode(view.subarray(BROWSER_HEADER_SIZE, metaAt)),
    meta,
    payload: view.slice(metaAt + metaLen)
  };
}

// Reassembles chunked frames and drops stale/duplicate traffic. Host seq is
// monotonic PER TARGET (a pane and a popup stream side by side on one bus), so
// stale-dropping and eviction are keyed per targetId — anything older than
// that target's last completed frame is a replayed cache frame arriving late.
export class FrameAssembler {
  constructor() {
    this._pending = new Map(); // `${targetId}:${seq}` → {chunks, received, count, meta}
    this._lastSeq = new Map(); // targetId → last completed seq
  }

  pendingSize() {
    return this._pending.size;
  }

  /** @returns {{targetId, seq, flags, meta, payload: Uint8Array} | null} */
  push(chunk) {
    const dec = decodeBrowserFrame(chunk);
    if (!dec || dec.seq < (this._lastSeq.get(dec.targetId) || 0)) return null;
    if (dec.chunkCount <= 1) {
      this._lastSeq.set(dec.targetId, dec.seq);
      return { targetId: dec.targetId, seq: dec.seq, flags: dec.flags, meta: dec.meta, payload: dec.payload };
    }
    const key = `${dec.targetId}:${dec.seq}`;
    let entry = this._pending.get(key);
    if (!entry) {
      // Ordered lane: anything still open far below this seq lost a chunk.
      for (const s of this._pending.keys()) {
        if (s.startsWith(`${dec.targetId}:`) && dec.seq - this._seqOf(s) >= ASSEMBLER_MAX_PENDING) this._pending.delete(s);
      }
      entry = { chunks: new Array(dec.chunkCount), received: 0, count: dec.chunkCount, meta: dec.meta };
      this._pending.set(key, entry);
    }
    if (entry.chunks[dec.chunkIdx]) return null; // duplicate chunk
    entry.chunks[dec.chunkIdx] = dec.payload;
    entry.received++;
    if (entry.received !== entry.count) return null;
    this._pending.delete(key);
    this._lastSeq.set(dec.targetId, dec.seq);
    const size = entry.chunks.reduce((n, c) => n + c.byteLength, 0);
    const payload = new Uint8Array(size);
    let at = 0;
    for (const c of entry.chunks) { payload.set(c, at); at += c.byteLength; }
    return { targetId: dec.targetId, seq: dec.seq, flags: dec.flags, meta: entry.meta, payload };
  }

  _seqOf(key) {
    return Number(key.slice(key.lastIndexOf(":") + 1));
  }
}
