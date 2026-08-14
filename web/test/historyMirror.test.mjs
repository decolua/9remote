// Characterization tests for the history-mirror byte math extracted from useXTerm.
// Run: node --import ./test/loader-alias.mjs web/test/historyMirror.test.mjs
import assert from "node:assert/strict";
import {
  utf8ByteLength, toChunk, chunkByteLength, writeChunked,
  dedupePrefix, viewportRestoreDelta, decodeMirror
} from "../features/terminal/lib/historyMirror.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("utf8ByteLength counts bytes, not UTF-16 code units", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("tiếng Việt"), 14); // ế = 3 bytes, rest ASCII
  assert.equal(utf8ByteLength("🚀"), 4);           // surrogate pair = 4 UTF-8 bytes
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength(null), 0);
});

test("toChunk normalizes buffers and strings", () => {
  assert.ok(toChunk(new ArrayBuffer(4)) instanceof Uint8Array);
  assert.ok(toChunk(new Uint8Array([1, 2])) instanceof Uint8Array);
  assert.equal(toChunk("str"), "str");
  assert.equal(toChunk(42), "42");
});

test("chunkByteLength: string → utf8 bytes, buffer → byteLength", () => {
  assert.equal(chunkByteLength("ế"), 3);
  assert.equal(chunkByteLength(new Uint8Array(7)), 7);
});

test("writeChunked pushes to mirror and counts bytes", () => {
  const mirror = { current: [] };
  const mirrorBytes = { current: 0 };
  const batched = [];
  const term = { write: (d) => batched.push(d) };
  writeChunked(term, "abc", mirror, mirrorBytes, null);
  writeChunked(term, new Uint8Array([1, 2, 3]), mirror, mirrorBytes, null);
  writeChunked(term, "ế", mirror, mirrorBytes, null);
  assert.equal(mirror.current.length, 3);
  assert.equal(mirrorBytes.current, 3 + 3 + 3);
  // with a batcher, the batcher gets the chunk instead of term.write
  const batcher = { write: (d) => batched.push(d) };
  writeChunked(term, "x", mirror, mirrorBytes, batcher);
  assert.deepEqual(batched[3], "x");
  // null term → no-op
  writeChunked(null, "x", mirror, mirrorBytes, null);
  assert.equal(mirror.current.length, 4);
  // null mirror → no bookkeeping
  writeChunked(term, "y", null, null, null);
  assert.equal(mirror.current.length, 4);
});

test("dedupePrefix: no overlap → untouched; overlap → trimmed to length", () => {
  const prefix = new Uint8Array([65, 66, 67, 68, 69]); // "ABCDE"
  assert.equal(dedupePrefix(prefix, { haveAtEmit: 0, historyBytes: 100 }), prefix);
  assert.equal(dedupePrefix(prefix, { haveAtEmit: 100, historyBytes: 100 }), prefix);
  // 3 bytes of live output landed since emit → keep 2 bytes
  const trimmed = dedupePrefix(prefix, { haveAtEmit: 100, historyBytes: 103 });
  assert.equal(trimmed.byteLength, 2);
  assert.deepEqual([...trimmed], [65, 66]);
  // overlap covers the whole prefix → empty
  const empty = dedupePrefix(prefix, { haveAtEmit: 100, historyBytes: 105 });
  assert.equal(empty.byteLength, 0);
  // string variant slices by bytes-approximation like the original (string .slice)
  const s = dedupePrefix("ABCDE", { haveAtEmit: 100, historyBytes: 103 });
  assert.equal(s, "AB");
});

test("dedupePrefix aligns byte cuts to ESC boundary for buffers", () => {
  // 4-byte chunk ending with a 3-byte escape "\x1b[[" — a cut at 2 would split it,
  // trimEndToEsc pulls back to before the ESC (1 byte)
  const esc = new Uint8Array([0x1b, 0x5b, 0x41, 0x1b]); // ESC [ A ESC
  const trimmed = dedupePrefix(esc, { haveAtEmit: 10, historyBytes: 13 }); // keep 1
  assert.deepEqual([...trimmed], [0x1b]);
});

test("viewportRestoreDelta: measured chunk lines shift the target up", () => {
  // old viewport 0, prefix added 25 lines → target 25 clamped to baseYAfter 20 → delta -200
  assert.equal(viewportRestoreDelta({ oldViewportY: 0, baseYBefore: 200, baseYAfter: 20 }), -20);
  // unclamped: viewport 100 + 25 added lines sits above baseYAfter 225 → scroll up 100
  assert.equal(viewportRestoreDelta({ oldViewportY: 100, baseYBefore: 200, baseYAfter: 225 }), -100);
  // zero delta → no scroll needed
  assert.equal(viewportRestoreDelta({ oldViewportY: 20, baseYBefore: 20, baseYAfter: 20 }), 0);
});

test("decodeMirror streams multibyte chars split across chunks", () => {
  // "ế" = 3 UTF-8 bytes split into two chunks — stream decode must reassemble
  const bytes = new TextEncoder().encode("ế");
  const out = decodeMirror([bytes.subarray(0, 1), bytes.subarray(1)]);
  assert.equal(out, "ế");
  assert.equal(decodeMirror(["a", new Uint8Array([98]), "c"]), "abc");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
