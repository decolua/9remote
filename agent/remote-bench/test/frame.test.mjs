// Test: bench harness computes median/min/mean on a fixed sample.
import { benchStats } from "../lib/frame.mjs";

export async function run() {
  let pass = 0, fail = 0;
  const ok = (c, m) => c ? pass++ : (fail++, console.log("  FAIL " + m));

  const s = benchStats([10, 20, 30, 40, 50]);
  ok(s.median === 30, `median=30 got ${s.median}`);
  ok(s.min === 10, `min=10 got ${s.min}`);
  ok(s.max === 50, `max=50 got ${s.max}`);
  ok(Math.abs(s.mean - 30) < 1e-9, `mean=30 got ${s.mean}`);

  const s2 = benchStats([5]); // single
  ok(s2.median === 5 && s2.min === 5 && s2.max === 5, "single element ok");

  const s3 = benchStats([1, 2]); // even count → upper-middle
  ok(s3.median === 2, `even-count median got ${s3.median}`);
  return { pass, fail };
}
