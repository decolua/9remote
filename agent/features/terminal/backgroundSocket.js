// Custom terminal background: client sends an image URL or data URL, the agent
// downloads/decodes, scales + compresses, stores one file under ~/.9remote and
// serves it back so every device logged in shares the same saved background.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("background");

// Tunables: input cap guards the fetch/decode step; quality steps walk the stored
// size under the cap. maxDim = longest edge (phone wallpaper, rendered via cover).
const BACKGROUND = {
  file: path.join(PATHS.BACKGROUNDS, "custom.jpg"),
  maxInputBytes: 10 * 1024 * 1024,
  maxStoredBytes: 400 * 1024,
  maxDim: 1080,
  qualities: [78, 65, 50],
  fetchTimeoutMs: 15000,
  maxUrlLength: 2048
};

// data:image/...;base64 payload → Buffer (null when malformed / over cap)
function decodeDataUrl(dataUrl) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  return buf.length && buf.length <= BACKGROUND.maxInputBytes ? buf : null;
}

async function fetchImageUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(BACKGROUND.fetchTimeoutMs),
    redirect: "follow",
    headers: { "user-agent": "9remote-agent" }
  });
  if (!res.ok) throw new Error(`URL returned ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > BACKGROUND.maxInputBytes) throw new Error("Image too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > BACKGROUND.maxInputBytes) throw new Error("Image too large");
  return buf;
}

// EXIF-rotate, scale longest edge down to maxDim, then walk JPEG quality until
// the buffer fits the stored cap (never enlarges a smaller image).
async function compressImage(input) {
  let out = null;
  for (const quality of BACKGROUND.qualities) {
    out = await sharp(input)
      .rotate()
      .resize({ width: BACKGROUND.maxDim, height: BACKGROUND.maxDim, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= BACKGROUND.maxStoredBytes) return out;
  }
  return out;
}

function readStoredBackground() {
  try {
    const buf = fs.readFileSync(BACKGROUND.file);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

export function setupBackgroundHandlers(socket) {
  socket.on("bg:save", async (payload = {}, cb) => {
    try {
      const input = payload.dataUrl
        ? decodeDataUrl(payload.dataUrl)
        : payload.url ? await fetchImageUrl(String(payload.url).slice(0, BACKGROUND.maxUrlLength)) : null;
      if (!input) return cb?.({ success: false, error: "Invalid image source" });

      const out = await compressImage(input);
      fs.mkdirSync(PATHS.BACKGROUNDS, { recursive: true });
      fs.writeFileSync(BACKGROUND.file, out);
      logger.info(`background saved (${(out.length / 1024).toFixed(0)}KB)`);
      cb?.({ success: true, dataUrl: `data:image/jpeg;base64,${out.toString("base64")}` });
    } catch (e) {
      logger.warn(`bg:save failed: ${e.message}`);
      cb?.({ success: false, error: e.message });
    }
  });

  socket.on("bg:get", (_payload, cb) => {
    const buf = readStoredBackground();
    if (!buf) return cb?.({ success: false });
    cb?.({ success: true, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` });
  });
}
