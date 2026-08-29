// Wire codec for non-socket.io adapters (RTC, future QUIC).
// Envelope shape: {event, args, ackId?}
//
// Two wire forms of the SAME envelope:
//   v1 (text)   — JSON string, buffers inlined as {__b: base64}. Legacy peers.
//   v2 (binary) — [4B headerLen LE][header JSON][part0][part1]... with buffers
//                 lifted out as {__B: i} markers and appended raw. No base64:
//                 25% less wire and no encode/decode on either end.
// This is the same shape socket.io already uses for WS (placeholder + binary
// attachment), so both carriers now serialize an envelope the same way.
// v2 is used only after both sides announce it (caps.env2) — the DataChannel
// distinguishes text from binary frames, so v1 and v2 coexist with no ambiguity.
// Mirrors agent/transport/codec.js — change both together.

const HEADER_LEN_BYTES = 4;

function replacer(_key, value) {
  if (value instanceof Uint8Array) {
    let bin = "";
    for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i]);
    return { __b: btoa(bin) };
  }
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.__b === "string") {
    const bin = atob(value.__b);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return value;
}

export function encode(envelope) {
  return JSON.stringify(envelope, replacer);
}

export function decode(wire) {
  return JSON.parse(typeof wire === "string" ? wire : new TextDecoder().decode(wire), reviver);
}

/** Lift every TypedArray/ArrayBuffer out of `value` into `parts`, leaving
 *  {__B: i} markers behind. Structure is preserved; only the bytes move. */
function lift(value, parts) {
  if (value instanceof ArrayBuffer) {
    parts.push(new Uint8Array(value));
    return { __B: parts.length - 1 };
  }
  if (ArrayBuffer.isView(value)) {
    parts.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return { __B: parts.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => lift(v, parts));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = lift(value[k], parts);
    return out;
  }
  return value;
}

/** Inverse of lift — put the raw parts back where their markers are. */
function drop(value, parts) {
  if (Array.isArray(value)) return value.map((v) => drop(v, parts));
  if (value && typeof value === "object") {
    if (typeof value.__B === "number") return parts[value.__B] ?? null;
    const out = {};
    for (const k of Object.keys(value)) out[k] = drop(value[k], parts);
    return out;
  }
  return value;
}

/** Serialize an envelope to the v2 binary frame. Returns a Uint8Array. */
export function encodeFrame(envelope) {
  const parts = [];
  const header = {
    event: envelope.event,
    args: lift(envelope.args || [], parts),
    ackId: envelope.ackId ?? null,
    // Part byte lengths, so the reader can slice without a per-part header.
    lens: parts.map((p) => p.length)
  };
  const headerBuf = new TextEncoder().encode(JSON.stringify(header));
  const total = HEADER_LEN_BYTES + headerBuf.length + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBuf.length, true);
  out.set(headerBuf, HEADER_LEN_BYTES);
  let off = HEADER_LEN_BYTES + headerBuf.length;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Parse a v2 binary frame back into {event, args, ackId}. Throws on a malformed
 *  frame — callers treat that like any other parse failure (drop the message).
 *
 *  The returned parts are VIEWS onto the frame's single buffer (no copy — this is
 *  the point of v2). They are safe to read, write into xterm, or wrap in a Blob.
 *  Do NOT transfer one to a Worker (postMessage(…, [buf])): that detaches the
 *  shared buffer and empties every sibling part. Copy it first if you must.
 *  Today's transfer sites (tile decoding) read from the dedicated BINARY channel,
 *  never from control, so none of them touch these views. */
export function decodeFrame(wire) {
  const buf = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
  if (buf.length < HEADER_LEN_BYTES) throw new Error("frame too short");
  const headerLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
  const headerEnd = HEADER_LEN_BYTES + headerLen;
  if (headerEnd > buf.length) throw new Error("frame header truncated");
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(HEADER_LEN_BYTES, headerEnd)));
  const parts = [];
  let off = headerEnd;
  for (const n of header.lens || []) {
    if (off + n > buf.length) throw new Error("frame part truncated");
    parts.push(buf.subarray(off, off + n));
    off += n;
  }
  return { event: header.event, args: drop(header.args || [], parts), ackId: header.ackId ?? null };
}
