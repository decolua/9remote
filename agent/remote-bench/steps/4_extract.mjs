// Step 4: tile extract (row-by-row Buffer.copy), tileSize 128 vs 256.
import { getRawFrame, bench } from "../lib/frame.mjs";

export default async function ({ logger } = {}) {
  const f = await getRawFrame();
  function extractAll(sd, TILE) {
    const cols = Math.ceil(sd.width / TILE), rowsN = Math.ceil(sd.height / TILE);
    const scratch = Buffer.allocUnsafe(TILE * TILE * 4);
    const rb = TILE * 4;
    for (let i = 0; i < cols * rowsN; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const sX = col * TILE, sY = row * TILE;
      const eX = Math.min(sX + TILE, sd.width), eY = Math.min(sY + TILE, sd.height);
      const tw = eX - sX, th = eY - sY, rrb = tw * 4;
      for (let y = 0; y < th; y++) { const so = ((sY + y) * sd.width + sX) * 4; sd.buffer.copy(scratch, y * rb, so, so + rrb); }
    }
    return cols * rowsN;
  }
  const rows = [];
  for (const TILE of [128, 256]) {
    const n = Math.ceil(f.width / TILE) * Math.ceil(f.height / TILE);
    rows.push(await bench(`tile ${TILE} → ${n} tiles`, () => extractAll(f, TILE)));
  }
  logger?.step("4_extract", { rows });
  return { name: "4_extract", rows };
}
