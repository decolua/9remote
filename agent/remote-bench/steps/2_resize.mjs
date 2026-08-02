// Step 2: full-frame resize, many kernels × fastShrink × scale.
import sharp from "sharp";
import { getRawFrame, bench } from "../lib/frame.mjs";

sharp.cache(false); sharp.concurrency(1);

export default async function ({ logger } = {}) {
  const f = await getRawFrame();
  const raw = { raw: { width: f.width, height: f.height, channels: 4 } };
  const scales = [0.75, 0.5];
  const kernels = ["lanczos3", "linear", "cubic", "nearest"];
  const rows = [];
  for (const s of scales) {
    const tw = Math.floor(f.width * s), th = Math.floor(f.height * s);
    for (const k of kernels) {
      for (const fast of [true, false]) {
        rows.push(await bench(`${s}× ${k.padEnd(8)} fastShrink=${fast ? "on" : "off"}`,
          () => sharp(f.buffer, raw).resize(tw, th, { kernel: k, fastShrinkOnLoad: fast }).raw().toBuffer()));
      }
    }
  }
  logger?.step("2_resize", { rows, total: rows.length });
  return { name: "2_resize", rows };
}
