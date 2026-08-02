// Step 8: native DXGI Desktop Duplication probe (spawn C# exe, parse output).
// Shows AcquireNextFrame(0) latency — the real ceiling if capture used DDA
// instead of node-screenshots' full-copy-every-call.
import { runDxgiProbe } from "../lib/dxgi_probe.mjs";

export default async function ({ logger, dxgiExe } = {}) {
  if (!dxgiExe) { logger?.warn("8_dxgi_native skipped — no probe exe (build failed)"); return { name: "8_dxgi_native", skipped: true }; }
  const result = runDxgiProbe(dxgiExe, { logger });
  logger?.info("[dxgi] native DDA result", {
    resolution: result.resolution,
    phaseA: result.phaseA,
    phaseB: result.phaseB,
    phaseC: result.phaseC
  });
  if (result.phaseA) {
    logger?.info(`[dxgi] AcquireNextFrame(0) median=${result.phaseA.median}ms  timeouts=${result.phaseA.timeouts ?? "?"}/${result.phaseA.total ?? "?"}  newContent=${result.phaseA.newContent ?? "?"}`);
  }
  return { name: "8_dxgi_native", resolution: result.resolution, phaseA: result.phaseA, phaseB: result.phaseB, phaseC: result.phaseC };
}
