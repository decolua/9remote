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
}

export async function getScreenSize() {
  const { captureLib } = REMOTE_CONFIG.pipeline;
  if (captureLib === "robotjs") {
    return robotRef.getScreenSize();
  }
  const m = await getMonitor();
  return { width: m.width, height: m.height };
}

export async function captureFull() {
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
  const m = await getMonitor();
  const image = m.captureImageSync();
  const raw = image.toRawSync ? image.toRawSync() : image.rawSync();
  return {
    buffer: raw,
    width: image.width,
    height: image.height,
    channels: 4,
    format: inputFormat
  };
}
