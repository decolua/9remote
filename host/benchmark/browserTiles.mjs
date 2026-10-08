// Benchmark: full-frame jpeg (old binary path) vs tile diffing (new path),
// fed REAL Chrome screencast frames through the exact production pipeline.
// Scenarios: initial paint, idle, small edit (20×20 toggle), scroll, full repaint.
// Run: node benchmark/browserTiles.mjs
import { createProfile, getOrLaunchBrowser, openTab, removeProfile, resolveChromeBinary } from "../features/browser/browserEngine.js";
import { decodeJpegRaw, diffTiles, makeGrid, buildTilesBatch } from "../features/browser/browserTileGrid.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";
import { BROWSER_TILE_SIZE, STREAM_TILE_FULL_RATIO } from "../features/browser/constants.js";
import { RENDER_SCALE } from "../features/browser/stream.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import crypto from "node:crypto";

const PROFILE = `bench-tiles-${Date.now().toString(36)}`;
const VIEWPORT = { width: 1284, height: 675 }; // the pane's real stage size
const QUALITY = 85;

// Rich, deterministic page: many blocks + text so jpeg tiles look like real pages.
const PAGE_HTML = `<!doctype html><html><body style="margin:0;font:14px/1.4 system-ui">
<div id="b" style="display:grid;grid-template-columns:repeat(8,1fr);gap:4px;padding:8px">
${Array.from({ length: 96 }, (_, i) =>
  `<div style="height:60px;background:hsl(${(i * 37) % 360},60%,${35 + (i % 5) * 8}%);border-radius:6px;padding:6px;color:#fff">blk ${i} lorem ipsum dolor sit amet</div>`
).join("")}
</div><div id="dot" style="position:fixed;left:40px;top:40px;width:20px;height:20px;background:#fff"></div>
</body></html>`;

// One shared listener labels every frame with the ACTIVE phase — no per-phase
// listener leaks. Each phase just runs its mutation on a timer for a duration.
async function runPhases(browser, sessionId, frames) {
  let label = "initial";
  let evalErr = "";
  const off = browser.client.on?.("Page.screencastFrame", (p, evSid) => {
    if (evSid !== sessionId) return;
    // UNCONDITIONAL ack — Chrome stalls its screencast queue otherwise.
    browser.client.call("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {});
    frames.push({ label, data: p.data });
  });
  const phase = async (name, script, ms) => {
    label = name;
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < ms) {
      if (script) {
        try {
          const r = await browser.client.call("Runtime.evaluate", { expression: script, returnByValue: true }, sessionId);
          if (r?.exceptionDetails) evalErr = `${name}: ${JSON.stringify(r.exceptionDetails.text).slice(0, 80)}`;
        } catch (e) { evalErr = `${name}: ${e.message}`; }
        n += 1;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 300)); // stragglers carry the same label
    return n;
  };

  await phase("initial (full grid)", null, 500);
  await phase("idle", null, 1200);
  await phase("small edit 20x20", "document.getElementById('dot').style.left=(document.getElementById('dot').style.left==='40px'?'200px':'40px')", 1500);
  const scrollStep = "window.scrollBy(0,scrollY+160>document.body.scrollHeight-innerHeight?-scrollY-10:160)";
  await phase("scroll", scrollStep, 1800);
  await phase("full repaint", "document.body.style.filter=(document.body.style.filter?'':'invert(1)')", 1200);
  off?.();
  return evalErr;
}

function stats(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { avg: Math.round(avg), p50: s[Math.floor(s.length / 2)] ?? 0, total: s.reduce((a, b) => a + b, 0) };
}

if (!resolveChromeBinary()) {
  console.log("No local Chromium — skipping");
  process.exit(0);
}
await createProfile(PROFILE);
const browser = await getOrLaunchBrowser(PROFILE);
const tab = await openTab(PROFILE, "about:blank");
try {
  const sessionId = await browser.sessionFor(tab.id);
  // Long data: URLs get truncated by the engine — inject the page instead.
  await browser.client.call("Runtime.evaluate", {
    expression: `document.open();document.write(${JSON.stringify(PAGE_HTML)});document.close();`,
    returnByValue: true
  }, sessionId);
  const size = { width: VIEWPORT.width * RENDER_SCALE, height: VIEWPORT.height * RENDER_SCALE };
  await browser.client.call("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: RENDER_SCALE, mobile: false }, sessionId);
  await browser.client.call("Page.enable", {}, sessionId);
  await browser.client.call("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: Math.round(size.width), maxHeight: Math.round(size.height), everyNthFrame: 1 }, sessionId);

  const frames = [];
  const pageProbe = await browser.client.call("Runtime.evaluate", { expression: "JSON.stringify({html:document.body.innerHTML.length, blocks:document.querySelectorAll('#b div').length})", returnByValue: true }, sessionId);
  const evalErr = await runPhases(browser, sessionId, frames);
  await browser.client.call("Page.stopScreencast", {}, sessionId).catch(() => {});

  const byLabel = new Map();
  for (const f of frames) byLabel.set(f.label, (byLabel.get(f.label) || 0) + 1);
  console.log(`\npage=${pageProbe?.result?.value} codec=${REMOTE_CONFIG.pipeline.tileFormat} tile=${BROWSER_TILE_SIZE}px viewport=${VIEWPORT.width}x${VIEWPORT.height}@${RENDER_SCALE}`);
  console.log(`frames=${frames.length} (${[...byLabel].map(([k, v]) => `${k}:${v}`).join(" ")})${evalErr ? ` evalErr=${evalErr}` : ""}\n`);

  // Replay the production pipeline over the captured frames, per phase.
  // Mirrors stream.js sendFrame: byte-identical skip → decode+diff → hybrid
  // (≥70% changed → passthrough the original jpeg, else tile-encode).
  const grid = makeGrid(Math.round(size.width), Math.round(size.height), BROWSER_TILE_SIZE);
  let prevHashes = null;
  let lastJpegHash = null;
  const phases = new Map();
  for (const f of frames) {
    const t0 = performance.now();
    const jpeg = Buffer.from(f.data, "base64");
    const oldBytes = jpeg.length;
    const tOld = performance.now() - t0; // the old path's whole cost (forward as-is)

    const t1 = performance.now();
    let newBytes = 0;
    let changed = 0; // -1 = byte-skipped, grid.totalTiles+ = passthrough
    const jpegHash = crypto.hash("md5", jpeg);
    if (prevHashes && lastJpegHash === jpegHash) {
      changed = -1; // byte-identical re-emission — skipped before decode
    } else {
      lastJpegHash = jpegHash;
      const raw = await decodeJpegRaw(jpeg);
      const grid2 = makeGrid(raw.width, raw.height, BROWSER_TILE_SIZE);
      const diff = diffTiles(prevHashes, raw, grid2);
      changed = diff.changed.length;
      prevHashes = diff.hashes;
      if (changed >= Math.ceil(grid2.totalTiles * STREAM_TILE_FULL_RATIO)) {
        newBytes = oldBytes; // hybrid passthrough — Chrome's jpeg forwarded
        changed = grid2.totalTiles + 1;
      } else if (changed > 0) {
        const tiles = await buildTilesBatch(raw, grid2, diff.changed, diff.hashes, QUALITY);
        newBytes = encodeTilesBatch(tiles, 0).length;
      }
    }
    const tNew = performance.now() - t1;

    const p = phases.get(f.label) || { n: 0, oldB: [], newB: [], newT: [], oldT: [], tiles: [] };
    p.n += 1; p.oldB.push(oldBytes); p.newB.push(newBytes); p.oldT.push(tOld); p.newT.push(tNew); p.tiles.push(changed);
    phases.set(f.label, p);
  }

  const pad = (s, n) => String(s).padEnd(n);
  const totalTiles = grid.totalTiles;
  console.log(`${pad("phase", 18)} ${pad("n", 4)} ${pad("action", 10)} ${pad("KB old", 9)} ${pad("KB new", 9)} ${pad("saved", 8)} ${pad("ms old", 7)} ${pad("ms new", 8)}`);
  let toB = 0, tnB = 0, toT = 0, tnT = 0;
  for (const [label, p] of phases) {
    const o = stats(p.oldB), n = stats(p.newB), ot = stats(p.oldT), nt = stats(p.newT);
    const act = p.tiles.filter((t) => t === -1).length >= p.tiles.length / 2 ? "byte-skip"
      : p.tiles.filter((t) => t > totalTiles).length >= p.tiles.length / 2 ? "passthru"
      : `tiles~${stats(p.tiles.filter((t) => t >= 0)).avg}/${totalTiles}`;
    toB += o.total; tnB += n.total; toT += ot.total; tnT += nt.total;
    const saved = o.total ? Math.round((1 - n.total / o.total) * 100) : 0;
    console.log(`${pad(label, 18)} ${pad(p.n, 4)} ${pad(act, 10)} ${pad(Math.round(o.avg / 1024), 9)} ${pad(Math.round(n.avg / 1024), 9)} ${pad(saved + "%", 8)} ${pad(ot.avg.toFixed(2), 7)} ${pad(nt.avg.toFixed(1), 8)}`);
  }
  console.log(`\nTOTAL wire: old ${(toB / 1024).toFixed(0)}KB → new ${(tnB / 1024).toFixed(0)}KB (${toB ? Math.round((1 - tnB / toB) * 100) : 0}% less)`);
  console.log(`TOTAL host CPU: old ${(toT).toFixed(0)}ms → new ${(tnT).toFixed(0)}ms (${(tnT / (toT || 1)).toFixed(0)}×)`);
} finally {
  await removeProfile(PROFILE).catch(() => {});
  process.exit(0);
}
