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

/** Serialize an envelope to the v2 binary frame. Returns a Buffer.
 *  `frag` = {id, part, parts} marks this frame as one slice of a larger envelope. */
export function encodeFrame(envelope, frag = null) {
  const parts = [];
  const header = {
    event: envelope.event,
    args: lift(envelope.args || [], parts),
    ackId: envelope.ackId ?? null,
    // Part byte lengths, so the reader can slice without a per-part header.
    lens: parts.map((p) => p.length)
  };
  if (frag) { header.frag = frag.id; header.part = frag.part; header.parts = frag.parts; }
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
  return { event: header.event, args: drop(header.args || [], parts), ackId: header.ackId ?? null, frag: header.frag, part: header.part, parts: header.parts };
}

// Ceiling on how many slices one envelope may be cut into — a peer announcing a
// huge count could otherwise make us allocate for a message that never arrives.
const MAX_FRAG_PARTS = 4096;

/** Cut a serialized frame into slices that each fit `maxBytes`, each slice still
 *  a valid frame once a fragment header is added. Returns [frame] when it already
 *  fits, or null when slicing cannot help — the payload does not fit even split,
 *  or the slice cap is exceeded. The caller then keeps the whole frame, which is
 *  the pre-fragment behaviour (and the peer's own limit decides what happens). */
export function sliceFrame(frame, maxBytes) {
  if (frame.length <= maxBytes) return [frame];
  // Overhead of the fragment header: the length prefix, the JSON envelope skeleton
  // and the three markers. Reserved rather than measured — a few bytes of slack
  // cost nothing, an under-estimate costs the message.
  const FRAG_HEADER_RESERVE = 192;
  const slice = maxBytes - FRAG_HEADER_RESERVE;
  if (slice <= 0) return null;
  const count = Math.ceil(frame.length / slice);
  if (count > MAX_FRAG_PARTS) return null;
  const out = [];
  for (let part = 0; part < count; part++) {
    out.push(frame.subarray(part * slice, Math.min((part + 1) * slice, frame.length)));
  }
  return out;
}

/** Wire frames for one envelope: a single frame when it fits `maxBytes`, else as
 *  many fragment frames as it takes. Returns null when the message cannot be sent
 *  on this carrier at all (see sliceFrame). */
export function encodeFragments(envelope, maxBytes, fragId) {
  const wire = encodeFrame(envelope);
  const slices = sliceFrame(wire, maxBytes);
  if (!slices) return null;
  if (slices.length === 1) return [wire];
  return slices.map((slice, part) => encodeFrame({ event: envelope.event, args: [slice] }, { id: fragId, part, parts: slices.length }));
}

// Reassembled frames hold the original envelope bytes until every slice lands, so
// the buffer is bounded: at most this many messages in flight, oldest dropped.
const MAX_INFLIGHT_FRAMES = 4;

/** Collects sliced frames back into whole envelopes (control channel). One per
 *  receiving peer: slices of different messages interleave on the wire, so parts
 *  are grouped by id. Yields an envelope-shaped object per completed message —
 *  the same shape decodeFrame returns, so callers treat it identically. */
export function createReassembler() {
  const pending = new Map();
  return {
    /** decoded: a decodeFrame result. Returns an envelope, or null while the
     *  message is still incomplete. */
    push(decoded) {
      const { frag, part, parts } = decoded;
      if (frag == null) return decoded;
      if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || parts < 1 || part >= parts || parts > MAX_FRAG_PARTS) return null;
      let entry = pending.get(frag);
      if (!entry) {
        if (pending.size >= MAX_INFLIGHT_FRAMES) pending.delete(pending.keys().next().value);
        entry = { slices: new Array(parts), got: 0 };
        pending.set(frag, entry);
      }
      const slice = decoded.args?.[0];
      if (slice == null) return null;
      if (!entry.slices[part]) { entry.slices[part] = slice; entry.got++; }
      if (entry.got < parts) return null;
      pending.delete(frag);
      return decodeFrame(Buffer.concat(entry.slices));
    }
  };
}
