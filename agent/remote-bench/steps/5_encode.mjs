// Step 5: tile encode — codecs, quality, effort, concurrency, tileSize.
import sharp from "sharp";
import { getRawFrame, bench } from "../lib/frame.mjs";

sharp.cache(false); sharp.concurrency(1);

export default async function ({ logger } = {}) {
  const f = await getRawFrame();
  const tile = (T) => Buffer.allocUnsafe(T * T * 4).fill(128);
  const a = [];
  for (const T of [128, 256]) {
    const tb = tile(T), raw = { raw: { width: T, height: T, channels: 4 } };
    for (const q of [50, 85]) a.push(await bench(`jpeg q${q} tile${T}`, () => sharp(tb, raw).jpeg({ quality: q }).toBuffer()));
    for (const e of [0, 4, 6]) a.push(await bench(`webp e${e} q85 tile${T}`, () => sharp(tb, raw).webp({ quality: 85, effort: e }).toBuffer()));
    a.push(await bench(`png tile${T}`, () => sharp(tb, raw).png().toBuffer()));
  }

  async function encAll(T, fmt, opt, conc) {
    const cols = Math.ceil(f.width / T), rowsN = Math.ceil(f.height / T);
    const tb = tile(T), raw = { raw: { width: T, height: T, channels: 4 } };
    const tasks = [];
    for (let i = 0; i < cols * rowsN; i++) tasks.push(sharp(tb, raw)[fmt](opt).toBuffer());
    for (let i = 0; i < tasks.length; i += conc) await Promise.all(tasks.slice(i, i + conc));
  }
  const b = [];
  for (const T of [256, 128]) {
    const n = Math.ceil(f.width / T) * Math.ceil(f.height / T);
    for (const c of [1, 4, 6, 12]) b.push(await bench(`jpeg q50 ${n}t conc${c}`, () => encAll(T, "jpeg", { quality: 50 }, c)));
    for (const c of [1, 4, 6, 12]) b.push(await bench(`webp e0 q85 ${n}t conc${c}`, () => encAll(T, "webp", { quality: 85, effort: 0 }, c)));
  }
  logger?.step("5_encode", { rows: [...a, ...b] });
  return { name: "5_encode", rows: [...a, ...b] };
}
