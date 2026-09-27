// Simulation benchmark: current mobile-stream flow control vs proposed drop+AIMD.
// Model only — no network IO, no production imports. Deterministic (seeded RNG).
// Run: node agent/test/mobileFlowBenchmark.mjs

// ─── Tunables (mirrors agent/features/mobile/constants.js) ──────────────────
const OLD_CFG = {
  ackWindow: 24,
  maxInFlightBytes: 256 * 1024,
  ackTimeoutMs: 1500,
  stallMs: 600,
  ackPollMs: 8
};

const NEW_CFG = {
  ackWindow: 64,
  winStart: 256 * 1024,
  winMin: 384 * 1024, // must exceed the largest keyframe, else window saturates forever
  winMax: 2 * 1024 * 1024,
  grow: 1.3,
  shrink: 0.7,
  ackTimeoutMs: 1500,
  keyframeReqMinGapMs: 300, // rely on the natural 1s IDR; forcing IDR floods fat frames when bandwidth is scarce
  adaptMs: 2000,           // goodput-driven bitrate: converge in one step, not 15s restart gaps
  goodputFactor: 0.85,     // GCC-style: on congestion, bitrate ← factor × measured acked rate
  restartGapMs: 8000
};

const ADAPT = { sampleWindowMs: 4000, minRestartGapMs: 15_000, congestedRatio: 0.5, healthyRatio: 0.1, stepDown: 0.7, stepUp: 1.15, minScale: 0.35 };
const FPS_MS = 1000 / 60;
const KEY_EVERY_MS = 1000; // i-frame-interval=1
const AVG_DELTA_BYTES = 12_000_000 / 8 / 60; // 12 Mbps @ 60fps ≈ 25 KB
const KEY_FACTOR = 8;
const SIM_MS = 60_000;

// ─── Deterministic RNG ───────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Link model: single bottleneck pipe (ordered, lossless like WS/SCTP) ────
class Link {
  constructor(bytesPerMs, rttMs) {
    this.bw = bytesPerMs;
    this.rtt = rttMs;
    this.lastDeliver = 0;
  }
  // Send at t, returns [deliveredAt, ackAt]
  send(t, size) {
    const delivered = Math.max(t, this.lastDeliver) + size / this.bw;
    this.lastDeliver = delivered;
    return [delivered, delivered + this.rtt];
  }
}

// ─── Encoder: scroll-heavy — every frame changes ────────────────────────────
class Encoder {
  constructor(rand) {
    this.rand = rand;
    this.nextAt = 0;
    this.forceKey = true; // first frame is IDR
    this.lastKeyAt = -Infinity;
    this.scale = 1;
  }
  setScale(s) { this.scale = s; }
  requestKeyframe() { this.forceKey = true; }
  produce(t) {
    const isKey = this.forceKey || (t - this.lastKeyAt) >= KEY_EVERY_MS;
    this.forceKey = false;
    if (isKey) this.lastKeyAt = t;
    const avg = AVG_DELTA_BYTES * this.scale * this.scale; // scaled(): bitrate ∝ area
    const size = Math.max(1024, Math.round(avg * (isKey ? KEY_FACTOR : 0.7 + 0.6 * this.rand())));
    return { isKey, size, producedAt: t };
  }
}

// The stall-time bookkeeping above got tangled with the 1ms step loop; rerun old
// with clean accounting (same logic, explicit stallMs accumulation).
function runOldClean(cfg, linkRand) {
  const link = linkRand.link, enc = linkRand.enc;
  const inFlight = new Map();
  let bytesInFlight = 0, seq = 0, waitingKey = false;
  const queue = [], acks = [];
  let blockedMs = 0, stallStart = -1, lastRestartAt = 0, adaptMark = 0;
  let chainOk = false, lastRenderAt = 0, rendered = 0, freezeMs = 0, maxFreeze = 0, wasted = 0;
  const latencies = [];
  let t = 0, nextProduce = 0;
  const full = () => inFlight.size >= cfg.ackWindow || bytesInFlight >= cfg.maxInFlightBytes;

  while (t < SIM_MS) {
    if (t >= nextProduce) { queue.push(enc.produce(t)); nextProduce += FPS_MS; }
    while (acks.length && acks[0].at <= t) {
      const a = acks.shift();
      for (const [s, f] of [...inFlight]) if (s <= a.seq) { bytesInFlight -= f.bytes; inFlight.delete(s); }
    }
    for (const [s, f] of [...inFlight]) if (f.expireAt <= t) { bytesInFlight -= f.bytes; inFlight.delete(s); }

    // bounded stall
    let waited = 0;
    while (!waitingKey && full() && waited < cfg.stallMs) { waited += cfg.ackPollMs; t += cfg.ackPollMs; }
    blockedMs += waited;

    // adapt every 4s, restart gap 15s — current signal: stall time only
    if (t - adaptMark >= ADAPT.sampleWindowMs) {
      const ratio = blockedMs / (t - adaptMark);
      blockedMs = 0; adaptMark = t;
      let next = enc.scale;
      if (ratio > ADAPT.congestedRatio) next = Math.max(ADAPT.minScale, enc.scale * ADAPT.stepDown);
      else if (ratio < ADAPT.healthyRatio) next = Math.min(1, enc.scale * ADAPT.stepUp);
      if (Math.abs(next - enc.scale) >= 0.05 && t - lastRestartAt >= ADAPT.minRestartGapMs) {
        enc.setScale(next); lastRestartAt = t;
      }
    }

    const frame = queue.shift();
    if (!frame) { t += 1; continue; }
    if (full()) {
      if (!waitingKey) { waitingKey = true; enc.requestKeyframe(); }
      chainOk = false; // dropped frame orphans later deltas at the receiver
      t += 1; continue;
    }
    if (waitingKey && !frame.isKey) { t += 1; continue; }
    if (frame.isKey) waitingKey = false;

    const [deliveredAt, ackAt] = link.send(t, frame.size);
    inFlight.set(seq, { bytes: frame.size, expireAt: t + cfg.ackTimeoutMs });
    bytesInFlight += frame.size;
    acks.push({ at: ackAt, seq }); seq++;

    if (frame.isKey) chainOk = true;
    if (chainOk) {
      rendered++;
      if (lastRenderAt) {
        const gap = deliveredAt - lastRenderAt;
        if (gap > 300) { freezeMs += gap; maxFreeze = Math.max(maxFreeze, gap); }
      }
      lastRenderAt = deliveredAt;
      latencies.push(deliveredAt - frame.producedAt);
    } else wasted += frame.size;
    t += 1;
  }
  return { rendered, freezeMs, maxFreeze, latencies, wasted, finalScale: enc.scale };
}

// ─── Strategy: NEW — drop-on-full + keyframe bypass + AIMD window ───────────
function runNew(cfg, linkRand) {
  const link = linkRand.link, enc = linkRand.enc;
  const inFlight = new Map();
  let bytesInFlight = 0, seq = 0, waitingKey = false;
  let win = cfg.winStart;
  const queue = [], acks = [];
  let blockedMs = 0, waitKeySince = -1;       // NEW signal: time in drop-mode counts
  let adaptMark = 0, lastRestartAt = 0;
  let lossy = false, lastGrowAt = 0, sawUtil = 0, lastKeyReq = -Infinity;
  let ackedBytes = 0, dropEpisodes = 0;
  let chainOk = false, lastRenderAt = 0, rendered = 0, freezeMs = 0, maxFreeze = 0, wasted = 0;
  const latencies = [], winSamples = [];
  let t = 0, nextProduce = 0;
  const full = () => inFlight.size >= cfg.ackWindow || bytesInFlight >= win;

  while (t < SIM_MS) {
    if (t >= nextProduce) { queue.push(enc.produce(t)); nextProduce += FPS_MS; }
    while (acks.length && acks[0].at <= t) {
      const a = acks.shift();
      for (const [s, f] of [...inFlight]) if (s <= a.seq) { bytesInFlight -= f.bytes; inFlight.delete(s); ackedBytes += f.bytes; }
      // AIMD grow: clean round + window actually utilized → probe more
      if (!lossy && sawUtil >= 0.9 * win && t - lastGrowAt >= 50) {
        win = Math.min(cfg.winMax, win * cfg.grow);
        lastGrowAt = t; sawUtil = 0;
      }
    }
    for (const [s, f] of [...inFlight]) {
      if (f.expireAt <= t) {
        bytesInFlight -= f.bytes; inFlight.delete(s);
        if (!lossy) { win = Math.max(cfg.winMin, win * cfg.shrink); lossy = true; sawUtil = 0; } // once per episode
      }
    }
    if (!lossy) sawUtil = Math.max(sawUtil, bytesInFlight);

    const frame = queue.shift();
    if (!frame) { t += 1; continue; }

    if (full() && !frame.isKey) {           // drop immediately, no stall
      if (!waitingKey) {
        waitingKey = true; waitKeySince = t; dropEpisodes++;
        if (t - lastKeyReq >= cfg.keyframeReqMinGapMs) { lastKeyReq = t; enc.requestKeyframe(); }
      }
      if (!lossy) { win = Math.max(cfg.winMin, win * cfg.shrink); lossy = true; sawUtil = 0; }
      chainOk = false;
      t += 1; continue;
    }
    if (waitingKey && !frame.isKey) { t += 1; continue; } // admit gate (keyframe passes through)
    if (frame.isKey) { waitingKey = false; if (waitKeySince >= 0) { blockedMs += t - waitKeySince; waitKeySince = -1; } }

    const [deliveredAt, ackAt] = link.send(t, frame.size);
    inFlight.set(seq, { bytes: frame.size, expireAt: t + cfg.ackTimeoutMs });
    bytesInFlight += frame.size;
    acks.push({ at: ackAt, seq }); seq++;

    if (frame.isKey) { chainOk = true; lossy = false; }
    if (chainOk) {
      rendered++;
      if (lastRenderAt) {
        const gap = deliveredAt - lastRenderAt;
        if (gap > 300) { freezeMs += gap; maxFreeze = Math.max(maxFreeze, gap); }
      }
      lastRenderAt = deliveredAt;
      latencies.push(deliveredAt - frame.producedAt);
    } else wasted += frame.size;

    // goodput-driven adapt: congestion → bitrate ← factor × acked rate (GCC-style)
    if (t - adaptMark >= cfg.adaptMs) {
      const interval = t - adaptMark;
      const goodputBps = (ackedBytes * 8 * 1000) / interval; // bits/s actually delivered
      const baseBps = 12_000_000;
      let next = enc.scale;
      if (dropEpisodes > 0) {
        // sizes ∝ scale² → scale = sqrt(target/base)
        next = Math.max(ADAPT.minScale, Math.sqrt((cfg.goodputFactor * goodputBps) / baseBps));
      } else if (goodputBps > 0.95 * baseBps * enc.scale * enc.scale) {
        next = Math.min(1, enc.scale * ADAPT.stepUp);
      }
      if (Math.abs(next - enc.scale) >= 0.05 && t - lastRestartAt >= cfg.restartGapMs) {
        enc.setScale(next); lastRestartAt = t;
      }
      ackedBytes = 0; dropEpisodes = 0; adaptMark = t;
    }
    winSamples.push(win);
    t += 1;
  }
  const avgWin = winSamples.reduce((a, b) => a + b, 0) / Math.max(1, winSamples.length);
  return { rendered, freezeMs, maxFreeze, latencies, wasted, finalScale: enc.scale, finalWin: win, avgWin };
}

// ─── Profiles + runner ───────────────────────────────────────────────────────
const PROFILES = [
  { name: "LAN (10ms, 50Mbps)", rtt: 10, bwMbps: 50 },
  { name: "Tunnel tot (100ms, 30Mbps)", rtt: 100, bwMbps: 30 },
  { name: "Tunnel TB (180ms, 15Mbps)", rtt: 180, bwMbps: 15 },
  { name: "Tunnel cham (300ms, 8Mbps)", rtt: 300, bwMbps: 8 },
  { name: "4G (250ms, 6Mbps)", rtt: 250, bwMbps: 6 }
];

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

function fmtRow(name, r, extra = "") {
  const avgLat = r.latencies.reduce((a, b) => a + b, 0) / Math.max(1, r.latencies.length);
  return [
    name,
    (r.rendered / (SIM_MS / 1000)).toFixed(1),
    (r.freezeMs / 1000).toFixed(1),
    (r.maxFreeze / 1000).toFixed(2),
    Math.round(avgLat),
    Math.round(pct(r.latencies, 0.95)),
    (r.wasted / 1024 / 1024).toFixed(1),
    r.finalScale.toFixed(2),
    extra
  ];
}

console.log(`Mobile stream flow-control benchmark (sim ${SIM_MS / 1000}s, scroll-heavy 60fps, 12Mbps encoder)`);
console.log("fps = khung hien thi/s | freeze = tong thoi gian dong bang (gap>300ms) | lat = end-to-end ms\n");

const HEAD = ["phien ban", "fps", "freeze(s)", "maxFz(s)", "latAvg", "latP95", "lang phi(MB)", "scale", "window"];
const rows = [HEAD];
for (const p of PROFILES) {
  const mk = () => ({ link: new Link(p.bwMbps * 1024 * 1024 / 8 / 1000, p.rtt), enc: new Encoder(mulberry32(42)) });
  const oldR = runOldClean(OLD_CFG, mk());
  const newR = runNew(NEW_CFG, mk());
  rows.push(fmtRow(`CU  ${p.name}`, oldR));
  rows.push(fmtRow(`MOI ${p.name}`, newR, `${(newR.finalWin / 1024).toFixed(0)}KB`));
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join(" | "));

