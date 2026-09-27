// Unit tests for gpuResize — the OpenCL per-tile resize adapter.
//
// What this proves on a NON-Win host (mac/linux CI): the fallback contract —
// init fails gracefully (no process crash), the cache reports null, and the
// hot-path guard refuses a null handle. The actual OpenCL happy-path (buffer
// reuse, correct pixels) only runs on Win with a real GPU; those assertions
// are gated behind isWin and skipped elsewhere.
//
// Run: node agent/test/gpuResize.test.mjs
import {
  initGpuResize,
  getGpuResize,
  isGpuTried,
  isGpuAvailable,
  resizeTile,
  _resetGpuResize
} from "../features/remote/adapters/gpuResize.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };
const isWin = process.platform === "win32";

// --- cache contract: fresh module is uninitialized ---
console.log("\n[cache: fresh state]");
await test("G1 getGpuResize() is null before any init", () => {
  _resetGpuResize();
  assert(getGpuResize() === null, "expected null before init");
});
await test("G2 isGpuTried() is false before init", () => {
  _resetGpuResize();
  assert(isGpuTried() === false, "expected false before init");
});

// --- init never throws, never crashes the process ---
// This is the critical fallback guarantee: even on mac/linux (no opencl.dll)
// or a Win box without a GPU, awaiting initGpuResize() must resolve null
// rather than reject — otherwise the stream loop crashes on startup.
console.log("\n[init: graceful fallback]");
await test("G3 initGpuResize() resolves (never rejects) on every platform", async () => {
  _resetGpuResize();
  const h = await initGpuResize(); // must not throw
  assert(h === null || typeof h === "object", "resolved to null or handle");
});
await test("G4 after init, isGpuTried() is true (no retry storm)", async () => {
  _resetGpuResize();
  await initGpuResize();
  assert(isGpuTried() === true, "tried flag set after init");
});
await test("G5 initGpuResize() is idempotent (second call returns same verdict)", async () => {
  _resetGpuResize();
  const a = await initGpuResize();
  const b = await initGpuResize();
  assert(a === b, "idempotent — same result on re-await");
});

// --- non-win verdict ---
// On mac/linux the handle MUST stay null: nothing for the hot path to use.
// On win it may be null (no GPU) or a handle — we only assert the non-win half.
console.log("\n[platform: non-win stays null]");
await test("G6 non-win: handle is null (no OpenCL to use)", async () => {
  _resetGpuResize();
  await initGpuResize();
  if (isWin) { console.log("    (skipped: running on win32)"); return; }
  assert(getGpuResize() === null, "non-win must not hold a GPU handle");
  assert(isGpuAvailable() === false, "isGpuAvailable false on non-win");
});

// --- hot-path guard: a null handle must throw, not segfault ---
// compressTileImage checks getGpuResize() before calling resizeTile, but the
// function itself must still defend — a stray call with a null handle should
// be a catchable Error, never a native crash (gpu.kernels would deref null).
console.log("\n[guard: null handle]");
await test("G7 resizeTile(null, ...) throws a catchable Error", () => {
  let threw = false;
  try { resizeTile(null, "bilinear", Buffer.alloc(16), 2, 2, 1, 1); }
  catch (e) { threw = true; assert(/null/i.test(e.message), "message mentions null"); }
  assert(threw, "expected throw on null handle");
});

// --- win happy-path: only meaningful with a real GPU ---
// Skipped on non-win and on win boxes where OpenCL init failed. When it does
// run, it verifies the reused-buffer contract: dims correct, outBuf reuse, and
// the MAX_TILE overflow guard throws (not silently truncates).
console.log("\n[win happy-path: gated on real GPU]");
await test("G8 win+GPU: resize returns buffer of the target dims", async () => {
  _resetGpuResize();
  await initGpuResize();
  const gpu = getGpuResize();
  if (!gpu) { console.log("    (skipped: no GPU handle)"); return; }
  const src = Buffer.alloc(128 * 128 * 4, 0x80);
  const out = resizeTile(gpu, "bilinear", src, 128, 128, 64, 64);
  assert(out.length === 64 * 64 * 4, `out size ${out.length}`);
});
await test("G9 win+GPU: outBuf reuse writes into the supplied buffer", async () => {
  const gpu = getGpuResize();
  if (!gpu) { console.log("    (skipped: no GPU handle)"); return; }
  const src = Buffer.alloc(64 * 64 * 4, 0x10);
  const sink = Buffer.allocUnsafe(32 * 32 * 4);
  const out = resizeTile(gpu, "nearest", src, 64, 64, 32, 32, sink);
  assert(out.buffer === sink.buffer, "reused the supplied outBuf");
});
await test("G10 win+GPU: oversize tile throws (MAX_TILE guard)", () => {
  const gpu = getGpuResize();
  if (!gpu) { console.log("    (skipped: no GPU handle)"); return; }
  // 513×1 exceeds MAX_TILE=512 → must throw rather than overflow the buffer.
  const big = Buffer.allocUnsafe(513 * 1 * 4);
  let threw = false;
  try { resizeTile(gpu, "nearest", big, 513, 1, 256, 1); }
  catch { threw = true; }
  assert(threw, "expected throw on oversize tile");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
