// Step 6: end-to-end 1 frame via real TileManager (full-refresh + no-change).
import { TileManager } from "../../agent/features/remote/TileManager.js";
import { capturePool } from "../../agent/features/remote/CapturePool.js";
import { bench } from "../lib/frame.mjs";

export default async function ({ logger } = {}) {
  const ns = await import("node-screenshots");
  const mon = ns.Monitor.all()[0];
  const robot = (await import("@hurdlegroup/robotjs")).default;
  const tm = new TileManager(robot, { monitor: mon });
  tm.activeTileSet = null;

  const full = await bench("detectChangedTilesWithHashes [full-refresh]", async () => {
    capturePool.clear(); tm.lastTileChecksums.clear();
    await tm.detectChangedTilesWithHashes();
  }, { warmup: 2, samples: 6 });
  capturePool.clear();
  await tm.detectChangedTilesWithHashes();
  tm.commitHashes(Array.from(tm.lastTileChecksums.keys()).map((k) => ({ tileIndex: k, hash: 0 })));
  const idle = await bench("detectChangedTilesWithHashes [no-change]", async () => {
    await tm.detectChangedTilesWithHashes();
  }, { warmup: 2, samples: 6 });

  const rows = [full, idle];
  logger?.step("6_e2e", { rows, capture: `${tm.captureWidth}x${tm.captureHeight}`, tiles: tm.totalTiles });
  return { name: "6_e2e", rows, capture: `${tm.captureWidth}x${tm.captureHeight}`, tiles: tm.totalTiles };
}
