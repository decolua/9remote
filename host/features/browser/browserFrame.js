// Binary framing for browser stream frames over the transport's ordered "file"
// channel. Mirrored verbatim in web/features/browser/lib/browserFrame.js —
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
// Header byte 13: payload flavor. 0 = one full JPEG, 1 = remote-desktop tile
// batch (encodeTilesBatch wire format) — the client picks its decoder by it.
export const BROWSER_FLAG_FULL = 0;
export const BROWSER_FLAG_TILES = 1;

export function encodeBrowserFrame({ targetId, seq, meta = {}, payload, flags = BROWSER_FLAG_FULL, chunkIdx = 0, chunkCount = 1 }) {
  const id = typeof targetId === "string" ? targetId.slice(0, 255) : String(targetId ?? "");
  const metaJson = new TextEncoder().encode(JSON.stringify(meta || {}));
  const data = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  const frame = new Uint8Array(BROWSER_HEADER_SIZE + id.length + metaJson.byteLength + data.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, BROWSER_FRAME_MAGIC);
  dv.setUint32(4, seq >>> 0);
  dv.setUint16(8, chunkIdx);
  dv.setUint16(10, chunkCount);
  dv.setUint8(12, id.length);
  dv.setUint8(13, flags);
  dv.setUint16(14, metaJson.byteLength);
  frame.set(new TextEncoder().encode(id), BROWSER_HEADER_SIZE);
  frame.set(metaJson, BROWSER_HEADER_SIZE + id.length);
  frame.set(data, BROWSER_HEADER_SIZE + id.length + metaJson.byteLength);
  return frame;
}

/** Split an oversize frame into decodable chunks of ≤ chunkBytes payload each. */
export function browserFrameChunks({ targetId, seq, meta, payload, flags }, chunkBytes) {
  const data = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  const cap = Math.max(1, chunkBytes | 0);
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / cap));
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push(encodeBrowserFrame({
      targetId, seq, meta, flags,
      payload: data.subarray(i * cap, (i + 1) * cap),
      chunkIdx: i, chunkCount
    }));
  }
  return chunks;
}

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
