// Standalone test for the Windows cursor-shape FFI used by winCursorShape.js
// Run on Windows:  node agent/test/_winCursor.mjs
// Move the mouse to a window edge (resize handle) and watch the output.
import koffi from "koffi";

const IDC = { ew: 32644, ns: 32645, nwse: 32642, nesw: 32643, all: 32646 };

const CURSORINFO = koffi.struct("CURSORINFO", {
  cbSize: "uint32",
  flags: "uint32",
  hCursor: "uint64_t",
  x: "int32",
  y: "int32"
});

const user32 = koffi.load("user32.dll");
// _Inout_ → koffi marshals the struct both ways (cbSize in, the rest out).
const GetCursorInfo = user32.func("bool GetCursorInfo(_Inout_ CURSORINFO *ci)");
// IDC_* are MAKEINTRESOURCE(word): a pointer whose value is the word id.
// koffi accepts a number as a pointer address → low-word pointer = id.
// Return as uint64_t so the handle is a plain number, not an opaque object.
const LoadCursorW = user32.func("uint64_t LoadCursorW(void *hInstance, void *lpCursorName)");

const cbSize = koffi.sizeof(CURSORINFO);
console.log(`cbSize=${cbSize}`);

const resizeMap = new Map();
for (const [dir, id] of Object.entries(IDC)) {
  const h = LoadCursorW(null, id);
  console.log(`LoadCursorW(${id}=${dir}) → ${h}`);
  if (h) resizeMap.set(String(h), dir);
}
console.log(`cached=${resizeMap.size}`);
if (!resizeMap.size) {
  console.error("No handles cached — LoadCursorW failed.");
  process.exit(1);
}

let lastDir = null;
let lastH = null;
setInterval(() => {
  const ci = { cbSize, flags: 0, hCursor: 0, x: 0, y: 0 };
  if (!GetCursorInfo(ci)) { console.log("GetCursorInfo FALSE"); return; }
  if (!ci.flags) return;
  const key = String(ci.hCursor);
  const dir = resizeMap.get(key) ?? null;
  if (dir !== lastDir || key !== lastH) {
    console.log(`hCursor=${key} flags=${ci.flags} pos=${ci.x},${ci.y} → ${dir}`);
    lastDir = dir;
    lastH = key;
  }
}, 150);
