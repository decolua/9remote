// Tile frame binary header (12 bytes): tileCount (u32 LE) + timestamp (f64 BE).
// The mixed endianness is the wire format the agent writes — do not "fix" it.
// Shared by the v1 (tiles-data-binary) and v2 (tiles-bin-v2) listeners.
const HEADER_BYTES = 12;

/** Normalize a bus payload (ArrayBuffer or TypedArray) to an ArrayBuffer. */
export function toArrayBuffer(buffer) {
  return buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
}

/**
 * Parse the benchmark fields out of a tile frame.
 * A short/missing buffer yields tileCount 0 and the local clock, matching the
 * pre-extraction behaviour (benchmark degrades, rendering is unaffected).
 * @returns {{tileCount:number, timestamp:number, bytes:number}}
 */
export function parseTileHeader(buffer, now = Date.now()) {
  const ab = toArrayBuffer(buffer);
  const bytes = ab?.byteLength || 0;
  let tileCount = 0;
  let timestamp = now;
  if (ab && ab.byteLength >= HEADER_BYTES) {
    const view = new DataView(ab);
    tileCount = view.getUint32(0, true);
    timestamp = view.getFloat64(4, false);
  }
  return { tileCount, timestamp, bytes };
}

/** Benchmark sample shape expected by useBenchmark.trackTilesReceived. */
export function tileStatsFrom(buffer, now = Date.now()) {
  const { tileCount, timestamp, bytes } = parseTileHeader(buffer, now);
  return { tiles: new Array(tileCount), timestamp, bytes };
}
