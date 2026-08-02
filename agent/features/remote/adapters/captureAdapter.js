// Capture adapter — unified API over robotjs (BGRA) and node-screenshots (RGBA/DXGI GPU)
// Returns { buffer, width, height, channels, format }
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

let robotRef = null;
let monitorRef = null;

async function getMonitor() {
  if (monitorRef) return monitorRef;
  const ns = await import("node-screenshots");
  const Monitor = ns.Monitor || ns.default?.Monitor;
  monitorRef = Monitor.all()[0];
  if (!monitorRef) throw new Error("No monitor found via node-screenshots");
  return monitorRef;
}

export async function initCapture(robot) {
  robotRef = robot;
  // Pre-warm node-screenshots if selected
  if (REMOTE_CONFIG.pipeline.captureLib === "nodeScreenshots") {
    await getMonitor();
  }
  // Win-only GPU resize accelerator. Lazy/background: a failure here MUST NOT
  // break startup — compressTileImage falls back to sharp when getGpuResize()
  // returns null.
  if (REMOTE_CONFIG.pipeline.gpuResize) {
    import("./gpuResize.js").then(({ initGpuResize }) => initGpuResize()).catch(() => {});
  }
}

export async function getScreenSize() {
  const { captureLib } = REMOTE_CONFIG.pipeline;
  if (captureLib === "robotjs") {
    return robotRef.getScreenSize();
  }
  const m = await getMonitor();
  return { width: m.width, height: m.height };
}

// preferredMonitor: per-client node-screenshots Monitor (multi-monitor).
// When passed, capture uses it directly and skips the global cache so each
// client can stream a different display concurrently.
export async function captureFull(preferredMonitor = null) {
  const { captureLib, inputFormat } = REMOTE_CONFIG.pipeline;

  if (captureLib === "robotjs") {
    const { width, height } = robotRef.getScreenSize();
    const bitmap = robotRef.screen.capture(0, 0, width, height);
    const actualWidth = bitmap.byteWidth / bitmap.bytesPerPixel;
    return {
      buffer: Buffer.from(bitmap.image),
      width: actualWidth,
      height: bitmap.height,
      channels: bitmap.bytesPerPixel,
      format: inputFormat
    };
  }

  // node-screenshots: DXGI on Win, XCap on Mac/Linux → RGBA bytes
  // Use async API — sync version leaks native Obj-C autoreleased objects on Mac
  // On Win the DXGI Desktop Duplication handle goes stale after lock screen,
  // RDP reconnect, display sleep, DPI change, or monitor unplug/replug — the
  // cached Monitor then throws (or yields corrupt output) forever. Invalidate
  // the cache on any failure so the next capture re-acquires a fresh handle.
  let m;
  try {
    m = preferredMonitor || await getMonitor();
    const image = await m.captureImage();
    const raw = await image.toRaw();
    return {
      buffer: raw,
      width: image.width,
      height: image.height,
      channels: 4,
      format: inputFormat
    };
  } catch (err) {
    if (!preferredMonitor) monitorRef = null;
    throw err;
  }
}
