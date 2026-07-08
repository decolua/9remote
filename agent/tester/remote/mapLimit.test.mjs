import assert from "node:assert";
import { mapLimit } from "../../features/remote/TileManager.js";

const LIMIT = 4;
let inFlight = 0;
let maxInFlight = 0;

const items = Array.from({ length: 20 }, (_, i) => i);
const out = await mapLimit(items, LIMIT, async (id) => {
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  await new Promise((r) => setTimeout(r, 5));
  inFlight--;
  return id;
});

assert.deepStrictEqual(out, items, "output must preserve order 0..19");
assert.ok(maxInFlight <= LIMIT, `concurrency exceeded: ${maxInFlight} > ${LIMIT}`);
assert.ok(maxInFlight > 1, "should actually run in parallel");

console.log(`OK C8 — order preserved, maxInFlight=${maxInFlight} (limit=${LIMIT})`);
