// Wire codec for non-socket.io adapters (RTC, future QUIC).
// Envelope: {event, args, ackId?}. Node uses Buffer (toJSON → {type:"Buffer", data:[]}).
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

const HEADER_LEN_BYTES = 4;

function replacer(_key, value) {
  if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
    return { __b: Buffer.from(value.data).toString("base64") };
  }
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.__b === "string") {
    return Buffer.from(value.__b, "base64");
  }
  return value;
}

export function encode(envelope) {
  return JSON.stringify(envelope, replacer);
}

export function decode(wire) {
  return JSON.parse(typeof wire === "string" ? wire : Buffer.from(wire).toString("utf8"), reviver);
}

/** Lift every Buffer/TypedArray out of `value` into `parts`, leaving {__B: i}
 *  markers behind. Structure is preserved; only the bytes move. */
function lift(value, parts) {
  if (Buffer.isBuffer(value)) {
    parts.push(value);
    return { __B: parts.length - 1 };
  }
  if (ArrayBuffer.isView(value)) {
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
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

/** Serialize an envelope to the v2 binary frame. Returns a Buffer. */
export function encodeFrame(envelope) {
  const parts = [];
  const header = {
    event: envelope.event,
    args: lift(envelope.args || [], parts),
    ackId: envelope.ackId ?? null,
    // Part byte lengths, so the reader can slice without a per-part header.
    lens: parts.map((p) => p.length)
  };
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.allocUnsafe(HEADER_LEN_BYTES);
  len.writeUInt32LE(headerBuf.length, 0);
  return Buffer.concat([len, headerBuf, ...parts]);
}

/** Parse a v2 binary frame back into {event, args, ackId}. Throws on a malformed
 *  frame — callers treat that like any other parse failure (drop the message).
 *
 *  The returned parts are subarray VIEWS onto the frame buffer (no copy — this is
 *  the point of v2): safe to read or write out, but do not hand one to something
 *  that takes ownership of the whole backing buffer. Copy it first if you must. */
export function decodeFrame(wire) {
  const buf = Buffer.isBuffer(wire) ? wire : Buffer.from(wire.buffer ?? wire, wire.byteOffset ?? 0, wire.byteLength ?? wire.length);
  if (buf.length < HEADER_LEN_BYTES) throw new Error("frame too short");
  const headerLen = buf.readUInt32LE(0);
  const headerEnd = HEADER_LEN_BYTES + headerLen;
  if (headerEnd > buf.length) throw new Error("frame header truncated");
  const header = JSON.parse(buf.subarray(HEADER_LEN_BYTES, headerEnd).toString("utf8"));
  const parts = [];
  let off = headerEnd;
  for (const n of header.lens || []) {
    if (off + n > buf.length) throw new Error("frame part truncated");
    parts.push(buf.subarray(off, off + n));
    off += n;
  }
  return { event: header.event, args: drop(header.args || [], parts), ackId: header.ackId ?? null };
}
