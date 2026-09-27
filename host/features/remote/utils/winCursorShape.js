// Detect OS resize cursor (Windows) so the remote virtual cursor can mirror it.
// Returns a resize direction string, or null when the OS cursor isn't a resize
// handle. Non-win32 platforms are unsupported → always null (no shape sync).
import koffi from "koffi";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("cursorShape");

let user32 = null;
let resizeMap = null;
let cbSize = 0;

if (process.platform === "win32") {
  try {
    const CURSORINFO = koffi.struct("CURSORINFO", {
      cbSize: "uint32",
      flags: "uint32",
      hCursor: "uint64_t",
      x: "int32",
      y: "int32"
    });
    cbSize = koffi.sizeof(CURSORINFO);
    const lib = koffi.load("user32.dll");
    // _Inout_ → koffi marshals the struct both ways (cbSize in, the rest out).
    user32 = {
      GetCursorInfo: lib.func("bool GetCursorInfo(_Inout_ CURSORINFO *ci)"),
      // IDC_* are MAKEINTRESOURCE(word): a pointer whose value is the word id.
      // koffi accepts a number as a pointer address → low-word pointer = id.
      // Return as uint64_t so the handle is a plain number, not an opaque object.
      LoadCursorW: lib.func("uint64_t LoadCursorW(void *hInstance, void *lpCursorName)")
    };
    // System cursor resource ids for the 5 resize variants.
    const IDC = { ew: 32644, ns: 32645, nwse: 32642, nesw: 32643, all: 32646 };
    resizeMap = new Map();
    for (const [dir, id] of Object.entries(IDC)) {
      const h = user32.LoadCursorW(null, id);
      if (h) resizeMap.set(String(h), dir);
    }
    log.info(`init win32 cbSize=${cbSize} cached=${resizeMap.size} handles=[${[...resizeMap.values()].join(",")}]`);
  } catch (e) {
    log.warn(`init failed: ${e.message}`);
    // koffi load failed (headless/server core) → no shape sync.
    user32 = null;
    resizeMap = null;
  }
}

let lastLogged = null;
export function getResizeShape() {
  if (!user32 || !resizeMap?.size) return null;
  const ci = { cbSize, flags: 0, hCursor: 0, x: 0, y: 0 };
  try {
    if (!user32.GetCursorInfo(ci)) return null;
    if (!ci.flags) return null; // cursor hidden
    const dir = resizeMap.get(String(ci.hCursor)) ?? null;
    if (dir !== lastLogged) {
      log.info(`query hCursor=${ci.hCursor} → ${dir}`);
      lastLogged = dir;
    }
    return dir;
  } catch (e) {
    log.warn(`query error: ${e.message}`);
    return null;
  }
}
