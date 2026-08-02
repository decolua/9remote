// Step 1: DXGI capture pipeline — GPU capture vs CPU readback.
import { bench, captureImageOnly, readback } from "../lib/frame.mjs";

export default async function ({ logger } = {}) {
  const N = 15;
  const rows = [];
  rows.push(await bench("DXGI captureImage() [GPU]", () => captureImageOnly(), { samples: N }));
  const img = await captureImageOnly();
  rows.push(await bench("image.toRaw() [GPU→CPU]", () => readback(img), { samples: N }));
  rows.push(await bench("captureImage + toRaw [full]", async () => { const i = await captureImageOnly(); await readback(i); }, { samples: N }));
  logger?.step("1_capture", { rows, resolution: `${img.width}x${img.height}` });
  return { name: "1_capture", rows, resolution: `${img.width}x${img.height}` };
}
