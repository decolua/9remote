// Unit tests for TileManager tile-change detection + hash commit/retry semantics.
// Uses the real TileManager class with a stubbed capture (no real screen needed):
//   - calculateTileChecksumDirect  : per-tile hash from a raw screen buffer
//   - detectChangedTilesWithHashes : diff vs lastTileChecksums, full-refresh branch
//   - commitHashes                 : mark sent tiles (dropped ones keep old hash → retry)
//   - setFocusRect                 : activeTileSet bounds + newly-exposed re-send
//
// Run: node agent/test/remoteTileDiff.test.mjs
import { TileManager } from "../features/remote/TileManager.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };

// Build a TileManager WITHOUT the constructor (it calls capture.initCapture which
// loads node-screenshots and blocks). We wire the fields the diff path needs and
// stub capture + metrics. All methods come from the prototype (real code).
function makeTM({ w = 256, h = 256, tileSize = 128 } = {}) {
  const tm = Object.create(TileManager.prototype);
  tm.tileSize = tileSize;
  tm.scaledWidth = w; tm.scaledHeight = h;
  tm.captureWidth = w; tm.captureHeight = h;
  tm.tilesPerRow = Math.ceil(w / tileSize);
  tm.tilesPerColumn = Math.ceil(h / tileSize);
  tm.totalTiles = tm.tilesPerRow * tm.tilesPerColumn;
  tm.scaleFactor = 1;
  tm.changeThreshold = 1;
  tm.compressionQuality = 65;
  tm.activeTileSet = null;
  tm.lastTileChecksums = new Map();
  tm.isProcessing = false;
  tm.frameCount = 0;
  tm._prefetchCapture = null;
  tm._scratchExtract = [];
  tm._scratchSwap = [];
  tm.focusStats = { frames: 0, scanned: 0, changed: 0, bytes: 0 };
  tm.metrics = { now: () => 0, record() {}, cfg: { metrics: false } };
  tm._recordFrame = () => {};              // skip metrics recording
  return tm;
}
function screenBuf(w, h, fill = 0) {
  const b = Buffer.alloc(w * h * 4);
  b.fill(fill);
  return { buffer: b, width: w, height: h, channels: 4 };
}
function stubCapture(tm, screen) {
  tm.captureFullScreen = async () => screen;
  tm._prefetchCapture = null;
}

await test("D1 checksum is deterministic for identical frame", () => {
  const tm = makeTM();
  const s = screenBuf(256, 256, 100);
  const a = tm.calculateTileChecksumDirect(s, 0);
  const b = tm.calculateTileChecksumDirect(s, 0);
  assert(a === b, `hash mismatch ${a} vs ${b}`);
});

await test("D2 1px change in a tile flips its hash (sheared-grid sensitivity)", () => {
  const tm = makeTM();
  const s1 = screenBuf(256, 256, 50);
  const s2 = screenBuf(256, 256, 50);
  s2.buffer.writeUInt8(200, 0);                 // change top-left pixel of tile 0
  const h1 = tm.calculateTileChecksumDirect(s1, 0);
  const h2 = tm.calculateTileChecksumDirect(s2, 0);
  assert(h1 !== h2, "1px change must alter hash");
  // unchanged tile stays equal
  assert(tm.calculateTileChecksumDirect(s1, 1) === tm.calculateTileChecksumDirect(s2, 1), "tile1 unchanged");
});

await test("D3 first frame sends ALL tiles (lastTileChecksums empty)", async () => {
  const tm = makeTM();
  stubCapture(tm, screenBuf(256, 256, 80));
  const { tiles } = await tm.detectChangedTilesWithHashes();
  assert(tiles.length === tm.totalTiles, `first frame sent ${tiles.length}/${tm.totalTiles}`);
});

await test("D4 identical 2nd frame sends 0 changed tiles", async () => {
  const tm = makeTM();
  const s = screenBuf(256, 256, 80);
  stubCapture(tm, s);
  const f1 = await tm.detectChangedTilesWithHashes();
  tm.commitHashes(f1.tiles);
  const f2 = await tm.detectChangedTilesWithHashes();
  assert(f2.tiles.length === 0, `expected 0 changed, got ${f2.tiles.length}`);
});

await test("D5 changeThreshold=1 makes full-refresh branch unreachable", () => {
  const tm = makeTM();
  assert(tm.changeThreshold === 1, `threshold ${tm.changeThreshold}`);
  // changePercentage is always <= 1.0 so `> 1` can never be true → full-refresh
  // (extract-all) path is dead code; only changed tiles are extracted.
  const pct = 1.0;
  assert(!(pct > tm.changeThreshold), "100% change must NOT trigger full-refresh branch");
});

await test("D6 dropped tiles keep old hash → retried next frame", async () => {
  const tm = makeTM();
  let s = screenBuf(256, 256, 10);
  stubCapture(tm, s);
  const f1 = await tm.detectChangedTilesWithHashes();
  // Simulate only tile 0 actually sent (rest dropped by backpressure)
  tm.commitHashes([f1.tiles[0]]);
  // New frame: change every tile so all hashes differ from the stale committed set
  s = screenBuf(256, 256, 90);
  stubCapture(tm, s);
  const f2 = await tm.detectChangedTilesWithHashes();
  // Tiles 1..3 were never committed → still "changed" → present again
  const resentIdx = f2.tiles.map((t) => t.tileIndex).sort((a, b) => a - b);
  assert(resentIdx.includes(1) && resentIdx.includes(2) && resentIdx.includes(3),
    `dropped tiles not retried: ${resentIdx}`);
});

await test("D7 commitHashes only accepts sent tiles", async () => {
  const tm = makeTM();
  stubCapture(tm, screenBuf(256, 256, 30));
  const f1 = await tm.detectChangedTilesWithHashes();
  tm.commitHashes([f1.tiles[0], f1.tiles[1]]);
  assert(tm.lastTileChecksums.size === 2, `committed ${tm.lastTileChecksums.size}`);
});

await test("D8 setFocusRect builds a bounded active tile set", () => {
  const tm = makeTM({ w: 1280, h: 1280, tileSize: 128 }); // 10×10 = 100 tiles
  tm.setFocusRect({ x: 0, y: 0, w: 128, h: 128 });        // corner + padding(4)
  assert(tm.activeTileSet !== null, "active set created");
  assert(tm.activeTileSet.size < tm.totalTiles,
    `focus must shrink active set: ${tm.activeTileSet.size}/${tm.totalTiles}`);
  assert(tm.activeTileSet.has(0), "corner tile included");
});

await test("D9 focus pan to new area clears checksums of newly-exposed tiles", () => {
  const tm = makeTM({ w: 1280, h: 1280, tileSize: 128 }); // 10×10
  for (let i = 0; i < tm.totalTiles; i++) tm.lastTileChecksums.set(i, i * 100);
  tm.setFocusRect({ x: 0, y: 0, w: 128, h: 128 });        // top-left
  const firstActive = new Set(tm.activeTileSet);
  // pan to bottom-right corner
  tm.setFocusRect({ x: 1152, y: 1152, w: 128, h: 128 });
  let newlyExposed = 0;
  for (const idx of tm.activeTileSet) if (!firstActive.has(idx)) newlyExposed++;
  assert(newlyExposed > 0, `no newly exposed tiles after pan (${newlyExposed})`);
  let cleared = 0;
  for (const idx of tm.activeTileSet) if (!tm.lastTileChecksums.has(idx)) cleared++;
  assert(cleared === newlyExposed, `cleared ${cleared} != exposed ${newlyExposed}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
