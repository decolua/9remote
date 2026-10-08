// Remote browser pane — pure helpers self-check.
// Run: node --import ./test/loader-alias.mjs test/browserPane.test.mjs
import assert from "node:assert/strict";
import { viewportPoint, containRect } from "../features/browser/lib/pointerMap.js";
import { cleanTabTitle, useBrowserStore } from "../shared/stores/browserStore.js";
import { buildPickPayload } from "../features/browser/lib/pickPayload.js";
import { resolveOmniboxInput } from "../features/browser/lib/omnibox.js";
import { FrameAssembler } from "../features/browser/lib/browserFrame.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Fake a host chunk pair — mirrors encodeBrowserFrame layout from the host.
const MAGIC = 0xfefefefe;
function hostChunk({ seq, chunkIdx, chunkCount, targetId, metaJson, payload, flags = 0 }) {
  const id = new TextEncoder().encode(targetId);
  const meta = new TextEncoder().encode(metaJson);
  const buf = new Uint8Array(16 + id.byteLength + meta.byteLength + payload.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC);
  dv.setUint32(4, seq >>> 0);
  dv.setUint16(8, chunkIdx);
  dv.setUint16(10, chunkCount);
  dv.setUint8(12, id.byteLength);
  dv.setUint8(13, flags);
  dv.setUint16(14, meta.byteLength);
  buf.set(id, 16);
  buf.set(meta, 16 + id.byteLength);
  buf.set(payload, 16 + id.byteLength + meta.byteLength);
  return buf;
}

test("FrameAssembler: single-chunk frame completes immediately", () => {
  const asm = new FrameAssembler();
  const out = asm.push(hostChunk({
    seq: 3, chunkIdx: 0, chunkCount: 1, targetId: "tab1",
    metaJson: '{"deviceWidth":800,"deviceHeight":600}',
    payload: new Uint8Array([1, 2, 3])
  }));
  assert.ok(out);
  assert.equal(out.targetId, "tab1");
  assert.equal(out.seq, 3);
  assert.equal(out.meta.deviceWidth, 800);
  assert.deepEqual([...out.payload], [1, 2, 3]);
});

test("FrameAssembler: out-of-order chunks reassemble; stale seq dropped", () => {
  const asm = new FrameAssembler();
  assert.equal(asm.push(hostChunk({
    seq: 2, chunkIdx: 1, chunkCount: 2, targetId: "tab1", metaJson: "{}",
    payload: new Uint8Array([9, 9])
  })), null);
  const done = asm.push(hostChunk({
    seq: 2, chunkIdx: 0, chunkCount: 2, targetId: "tab1", metaJson: "{}",
    payload: new Uint8Array([1, 2])
  }));
  assert.ok(done);
  assert.deepEqual([...done.payload], [1, 2, 9, 9]);
  // Stale replay of an older frame must not paint over the newer one.
  assert.equal(asm.push(hostChunk({
    seq: 1, chunkIdx: 0, chunkCount: 1, targetId: "tab1", metaJson: "{}",
    payload: new Uint8Array([7])
  })), null);
});

test("FrameAssembler: foreign frames ignored, incomplete entries bounded", () => {
  const asm = new FrameAssembler();
  assert.equal(asm.push(new Uint8Array(10)), null); // not our magic
  // 32 half-frames must not grow the map unbounded
  for (let i = 0; i < 32; i++) {
    asm.push(hostChunk({ seq: 100 + i, chunkIdx: 0, chunkCount: 2, targetId: "t", metaJson: "{}", payload: new Uint8Array(4) }));
  }
  assert.ok(asm.pendingSize() <= 16, `bounded pending, got ${asm.pendingSize()}`);
});

test("FrameAssembler: interleaved targets keep independent seq windows", () => {
  const asm = new FrameAssembler();
  const a1 = asm.push(hostChunk({ seq: 9, chunkIdx: 0, chunkCount: 1, targetId: "pane", metaJson: "{}", payload: new Uint8Array([1]) }));
  assert.ok(a1, "pane seq 9 completes");
  // The popup's stream is younger — its low seq must NOT read as stale.
  const b1 = asm.push(hostChunk({ seq: 2, chunkIdx: 0, chunkCount: 1, targetId: "popup", metaJson: "{}", payload: new Uint8Array([2]) }));
  assert.ok(b1 && b1.targetId === "popup", "popup seq 2 completes despite pane seq 9");
  // And back: pane's next frame is still above pane's own watermark only.
  const a2 = asm.push(hostChunk({ seq: 10, chunkIdx: 0, chunkCount: 1, targetId: "pane", metaJson: "{}", payload: new Uint8Array([3]) }));
  assert.ok(a2, "pane seq 10 completes");
});

test("FrameAssembler: flags byte survives single and chunked frames", () => {
  const single = new FrameAssembler().push(hostChunk({ seq: 1, chunkIdx: 0, chunkCount: 1, targetId: "t", metaJson: "{}", payload: new Uint8Array([9]), flags: 1 }));
  assert.equal(single.flags, 1, "tile-batch flag on a single-chunk frame");
  const asm = new FrameAssembler();
  asm.push(hostChunk({ seq: 5, chunkIdx: 1, chunkCount: 2, targetId: "t", metaJson: "{}", payload: new Uint8Array([4, 4]), flags: 1 }));
  const joined = asm.push(hostChunk({ seq: 5, chunkIdx: 0, chunkCount: 2, targetId: "t", metaJson: "{}", payload: new Uint8Array([1, 2]), flags: 1 }));
  assert.ok(joined && joined.flags === 1, "flag survives chunk reassembly");
});

test("cleanTabTitle strips the engine's 🚀 stamp", () => {
  assert.equal(cleanTabTitle("🚀 [2] My Page"), "My Page");
  assert.equal(cleanTabTitle("🚀 [12]"), "");
  assert.equal(cleanTabTitle("Plain title"), "Plain title");
  assert.equal(cleanTabTitle(null), "");
});

test("buildPickPayload compiles picked elements with optional fields", () => {
  const out = buildPickPayload([
    { tag: "button", selector: "#login > button", text: "Sign in", href: null, rect: { x: 10, y: 20, width: 88, height: 32 } },
    { tag: "h1", selector: "h1", text: "", href: "https://x.test" }
  ], "https://example.test");
  assert.ok(out.startsWith("## Browser Elements (2)\nPage: https://example.test"));
  assert.ok(out.includes("### 1. `<button>`"));
  assert.ok(out.includes('- Selector: `#login > button`'));
  assert.ok(out.includes('- Text: "Sign in"'));
  assert.ok(out.includes("- Rect: 10,20 88×32"));
  assert.ok(out.includes("- Link: https://x.test"));
  assert.equal(out.match(/- Text:/g)?.length, 1); // empty text omitted
  assert.equal(out.match(/- Rect:/g)?.length, 1); // missing rect omitted
});

test("buildPickPayload counts even when fields are missing", () => {
  const out = buildPickPayload([{ tag: "div" }]);
  assert.ok(out.startsWith("## Browser Elements (1)"));
  assert.ok(out.includes("### 1. `<div>`"));
  assert.ok(out.includes("- Selector: `div`"));
});

test("viewportPoint maps image px to viewport CSS px", () => {
  const rect = { width: 400, height: 800 };
  const meta = { deviceWidth: 800, deviceHeight: 1600, scale: 1 };
  const p = viewportPoint(100, 200, rect, meta);
  assert.equal(p.x, 200);
  assert.equal(p.y, 400);
});

test("viewportPoint divides by pinch scale", () => {
  const p = viewportPoint(0, 0, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(p.x, 0);
  const half = viewportPoint(200, 400, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(half.x, 200);
  assert.equal(half.y, 400);
});

test("viewportPoint falls back to the rect when meta is missing", () => {
  const p = viewportPoint(50, 100, { width: 100, height: 200 }, null);
  assert.equal(p.x, 50);
  assert.equal(p.y, 100);
});

test("viewportPoint accounts for object-contain letterboxing", () => {
  // Square page inside a tall stage: drawn image is 400x400 offset y=200.
  const meta = { deviceWidth: 800, deviceHeight: 800, scale: 1 };
  const p = viewportPoint(200, 400, { width: 400, height: 800 }, meta);
  assert.equal(p.x, 400);
  assert.equal(p.y, 400);
  // A tap inside the top letterbox bar clamps to the image edge, not negative.
  const top = viewportPoint(200, 50, { width: 400, height: 800 }, meta);
  assert.equal(top.y, 0);
});

test("containRect centers a contain-fit image", () => {
  const r = containRect(400, 800, 800, 800);
  assert.equal(r.w, 400);
  assert.equal(r.h, 400);
  assert.equal(r.x, 0);
  assert.equal(r.y, 200);
});

test("browserStore workspace-keyed tabs, profile and window maps", () => {
  const st = useBrowserStore.getState();
  st.setTabs("ws1", [{ id: "A", title: "x" }]);
  st.setTabs("ws2", [{ id: "B" }]);
  assert.equal(useBrowserStore.getState().tabsByWorkspace.ws1.length, 1);
  assert.equal(useBrowserStore.getState().tabsByWorkspace.ws2[0].id, "B");
  st.setTabs("ws1", null);
  assert.equal(useBrowserStore.getState().tabsByWorkspace.ws1.length, 0);
  st.setActive("ws2", "B");
  assert.equal(useBrowserStore.getState().activeByWorkspace.ws2, "B");
  st.setProfileFor("ws1", "work");
  assert.equal(useBrowserStore.getState().profileFor("ws1"), "work");
  assert.equal(useBrowserStore.getState().profileFor("unknown-ws"), "default");
  st.setWindowFor("ws1", 7);
  assert.equal(useBrowserStore.getState().windowFor("ws1"), 7);
  assert.equal(useBrowserStore.getState().windowFor("ws2"), null);
  // Switching profile invalidates the workspace's Chrome window.
  st.setProfileFor("ws1", "default");
  assert.equal(useBrowserStore.getState().windowFor("ws1"), null);
});

test("resolveOmniboxInput: URLs vs search queries", () => {
  assert.equal(resolveOmniboxInput(""), null);
  assert.equal(resolveOmniboxInput("   "), null);

  // Full URL with scheme
  assert.deepEqual(resolveOmniboxInput("https://github.com"), { url: "https://github.com", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("http://example.com/test"), { url: "http://example.com/test", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("about:blank"), { url: "about:blank", isSearch: false });

  // Bare domains and IPs become https://
  assert.deepEqual(resolveOmniboxInput("google.com"), { url: "https://google.com", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("localhost:3000"), { url: "https://localhost:3000", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("192.168.1.1:8080/path"), { url: "https://192.168.1.1:8080/path", isSearch: false });

  // Search queries with spaces or non-host strings
  assert.deepEqual(resolveOmniboxInput("hello world"), {
    url: "https://www.google.com/search?q=hello%20world",
    isSearch: true
  });
  assert.deepEqual(resolveOmniboxInput("react vs vue 2026"), {
    url: "https://www.google.com/search?q=react%20vs%20vue%202026",
    isSearch: true
  });
  assert.deepEqual(resolveOmniboxInput("justaword"), {
    url: "https://www.google.com/search?q=justaword",
    isSearch: true
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
