// Frame pipeline metrics — rolling average, logged every N frames via TUI log panel
import { REMOTE_CONFIG } from "./REMOTE_CONFIG.js";
import { pushUiLog } from "../../api/ui.js";

export class FrameMetrics {
  constructor() {
    this.cfg = REMOTE_CONFIG.logging;
    this.samples = [];
    this.lastLogTime = Date.now();
  }

  now() {
    return this.cfg.metrics ? performance.now() : 0;
  }

  record({ capture, checksum, encode, total, changedTiles, totalTiles, tileBytes, rawBytes }) {
    if (!this.cfg.metrics) return;
    this.samples.push({ capture, checksum, encode, total, changedTiles, totalTiles, tileBytes, rawBytes });
    if (this.samples.length >= this.cfg.metricsEveryFrames) this._flush();
  }

  _flush() {
    const n = this.samples.length;
    const avg = (key) => (this.samples.reduce((s, x) => s + x[key], 0) / n).toFixed(1);
    const elapsed = (Date.now() - this.lastLogTime) / 1000;
    const fps = (n / elapsed).toFixed(1);

    // Tile stats: aggregate all tile sizes across samples
    const allTileSizes = [];
    let totalBytes = 0;
    for (const s of this.samples) {
      for (const b of s.tileBytes) allTileSizes.push(b);
      totalBytes += s.tileBytes.reduce((a, b) => a + b, 0);
    }
    const avgBytesPerFrame = (totalBytes / n / 1024).toFixed(1);
    const avgTileKB = allTileSizes.length ? (allTileSizes.reduce((a, b) => a + b, 0) / allTileSizes.length / 1024).toFixed(2) : "0";
    const minTileKB = allTileSizes.length ? (Math.min(...allTileSizes) / 1024).toFixed(2) : "0";
    const maxTileKB = allTileSizes.length ? (Math.max(...allTileSizes) / 1024).toFixed(2) : "0";

    // Compression ratio: avg raw bytes vs avg encoded bytes per frame
    const avgRaw = this.samples.reduce((s, x) => s + x.rawBytes, 0) / n;
    const avgEnc = totalBytes / n;
    const compressRatio = avgEnc > 0 ? (avgRaw / avgEnc).toFixed(0) : "0";

    const avgChanged = (this.samples.reduce((s, x) => s + x.changedTiles, 0) / n).toFixed(0);
    const totalTiles = this.samples[0]?.totalTiles || 0;
    const changePct = totalTiles ? ((avgChanged / totalTiles) * 100).toFixed(1) : "0";
    const lib = REMOTE_CONFIG.pipeline;

    const msg =
      `[Metrics] ${lib.captureLib}+${lib.encoder} tile=${lib.tileSize} q${lib.jpegQuality} scale=${lib.outputScale} | ` +
      `fps=${fps} | capture=${avg("capture")}ms enc=${avg("encode")}ms total=${avg("total")}ms | ` +
      `tiles=${avgChanged}/${totalTiles} (${changePct}%) | ` +
      `data=${avgBytesPerFrame}KB/frame | tileAvg=${avgTileKB}KB (min ${minTileKB}, max ${maxTileKB}) | ` +
      `compress=${compressRatio}x`;
    pushUiLog(msg);
    this.samples = [];
    this.lastLogTime = Date.now();
  }
}
