// Step 3: tile change-detection checksum (ported verbatim from TileManager).
import { getRawFrame, bench } from "../lib/frame.mjs";

export default async function ({ logger } = {}) {
  const f = await getRawFrame();
  const TILE = 256;
  const COLS = Math.ceil(f.width / TILE), ROWS = Math.ceil(f.height / TILE), TOTAL = COLS * ROWS;

  function checksum(sd, i, rs, cs) {
    const row = Math.floor(i / COLS), col = i % COLS;
    const sX = col * TILE, sY = row * TILE;
    const eX = Math.min(sX + TILE, sd.width), eY = Math.min(sY + TILE, sd.height);
    const tw = eX - sX, th = eY - sY, ch = 4, rb = sd.width * ch;
    let sum = 0;
    for (let y = 0; y < th; y += rs) {
      const ox = ((y / rs) | 0) % cs;
      const ro = (sY + y) * rb + (sX + ox) * ch;
      for (let x = ox; x < tw; x += cs) {
        const o = ro + (x - ox) * ch, w = x + 1;
        sum = (sum + sd.buffer[o] * w) >>> 0; sum ^= sd.buffer[o + 1] << 1;
        sum = (sum + sd.buffer[o + 2] * w) >>> 0; sum ^= sd.buffer[o + 3] << 2;
      }
    }
    return sum >>> 0;
  }

  const configs = [[2, 4], [2, 8], [3, 4], [3, 8], [3, 16], [4, 8], [4, 16]];
  const rows = [];
  for (const [rs, cs] of configs) {
    rows.push(await bench(`rowStep=${rs} colStep=${cs} (${TOTAL}t)`, () => { for (let i = 0; i < TOTAL; i++) checksum(f, i, rs, cs); }));
  }
  rows.push(await bench("full-pixel scan (baseline)", () => { let s = 0; for (let i = 0; i < f.buffer.length; i += 4) s = (s + f.buffer[i]) >>> 0; return s; }));
  logger?.step("3_checksum", { rows, tiles: TOTAL });
  return { name: "3_checksum", rows, tiles: TOTAL };
}
