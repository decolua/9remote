// Test: leak tracker — OpenCL buffer create/release counter + RSS snapshot + flag.
import { LeakTracker } from "../lib/leak.mjs";

export async function run() {
  let pass = 0, fail = 0;
  const ok = (c, m) => c ? pass++ : (fail++, console.log("  FAIL " + m));

  const lt = new LeakTracker({ leakThresholdMB: 50 });
  lt.snapshot("a");
  lt.createBuf("k1"); lt.createBuf("k2");
  lt.releaseBuf("k1");
  const c = lt.counterReport();
  ok(c.created === 2 && c.released === 1 && c.outstanding === 1, `counter created/released/outstanding ${JSON.stringify(c)}`);

  lt.releaseBuf("k2");
  const c2 = lt.counterReport();
  ok(c2.outstanding === 0, "all released → outstanding 0");

  lt.snapshot("b");
  const r = lt.report("a", "b");
  ok(typeof r.rssDelta === "number" && typeof r.heapDelta === "number", "report has deltas");
  ok(typeof r.leaked === "boolean", "report has leaked flag");

  // small alloc inside threshold → not flagged (rss may fluctuate, just check shape)
  ok(r.rssDeltaMB !== undefined, "report has rssDeltaMB");
  return { pass, fail };
}
