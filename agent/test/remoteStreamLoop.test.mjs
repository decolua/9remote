// Unit tests for the agent streaming loop (ScreenHandler "start-streaming" handler).
// Replicates streamLoop verbatim with mock collaborators so we can attack timing,
// re-entrancy, retry-on-throw, backpressure commit, and stop/gen-bump exit.
// Source: agent/features/remote/handlers/ScreenHandler.js
//
// Run: node agent/test/remoteStreamLoop.test.mjs
let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── streamLoop replica (line-for-line) ───────────────────────────────────────
class StreamLoop {
  constructor({ tileManager, protocol, socket, config }) {
    this.tm = tileManager;
    this.protocol = protocol;
    this.socket = socket;
    this.cfg = config;                  // { activeInterval, idleInterval, idleThreshold }
    this.isStreaming = false;
    this.streamGen = 0;
    this.streamingTimeout = null;
    this.idleFrameCount = 0;
    this.frameLog = [];                 // { t, tiles: N, sent: N, idle: bool }
    this.retryCount = 0;
    this.exitReason = null;
  }
  start() {
    this.isStreaming = true;
    this.streamGen = (this.streamGen || 0) + 1;
    const myGen = this.streamGen;
    this.tm.lastTileChecksums.clear();
    this._loop(myGen);
  }
  _loop(myGen) {
    const streamLoop = async () => {
      if (!this.socket.connected || !this.isStreaming || this.streamGen !== myGen) {
        this.streamingTimeout = null;
        this.exitReason = !this.socket.connected ? "disconnect"
          : !this.isStreaming ? "stopped" : "gen";
        return;
      }
      try {
        const frameStart = now();
        const result = await this.tm.detectChangedTilesWithHashes();
        if (result.tiles.length > 0 && this.socket.connected) {
          const sent = this.protocol.sendTiles({ tiles: result.tiles, timestamp: now() });
          this.tm.commitHashes(sent || []);
          this.idleFrameCount = 0;
          this.frameLog.push({ t: now(), tiles: result.tiles.length, sent: sent?.length ?? 0, idle: false });
        } else {
          this.idleFrameCount++;
          this.frameLog.push({ t: now(), tiles: 0, sent: 0, idle: true });
        }
        const { activeInterval, idleInterval, idleThreshold } = this.cfg;
        const baseInterval = this.idleFrameCount >= idleThreshold ? idleInterval : activeInterval;
        const nextInterval = Math.max(0, baseInterval - (now() - frameStart));
        this.streamingTimeout = setTimeout(streamLoop, nextInterval);
      } catch (error) {
        this.retryCount++;
        this.streamingTimeout = setTimeout(streamLoop, 200);
      }
    };
    streamLoop();
  }
  stop() {
    this.isStreaming = false;
    if (this.streamingTimeout) { clearTimeout(this.streamingTimeout); this.streamingTimeout = null; }
  }
  bumpGen() { this.streamGen++; }       // simulate restart抢占
  disconnect() { this.socket.connected = false; }
}

// ─── Mock collaborators ──────────────────────────────────────────────────────
const mkTm = ({ tilesPerFrame = [4], failOn = -1 } = {}) => {
  let call = 0;
  const committed = [];
  return {
    lastTileChecksums: { clear() {}, size: 0 },
    async detectChangedTilesWithHashes() {
      if (call === failOn) throw new Error("capture prefetch rejected");
      const n = tilesPerFrame[call % tilesPerFrame.length] ?? 0;
      call++;
      return { tiles: Array.from({ length: n }, (_, i) => ({ tileIndex: i, hash: call * 100 + i })), currentHashes: [] };
    },
    commitHashes(sent) { committed.push(sent.map((t) => t.tileIndex)); },
    _committed: committed,
  };
};
const mkProtocol = ({ dropAfter = Infinity } = {}) => {
  let sent = 0;
  return {
    sendTiles({ tiles }) {
      const out = tiles.slice(0, Math.max(0, Math.min(tiles.length, dropAfter - sent)));
      sent += out.length;
      return out;
    },
  };
};
const mkSocket = () => ({ connected: true });

const FAST = { activeInterval: 12, idleInterval: 40, idleThreshold: 3 };

// ─── Tests ────────────────────────────────────────────────────────────────────
await test("L1 loop runs multiple frames at activeInterval", async () => {
  const sl = new StreamLoop({ tileManager: mkTm(), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(100);
  sl.stop();
  assert(sl.frameLog.length >= 3, `frames ${sl.frameLog.length}`);
  assert(sl.retryCount === 0, `unexpected retries ${sl.retryCount}`);
});

await test("L2 idle threshold switches to idleInterval (slower cadence)", async () => {
  const sl = new StreamLoop({ tileManager: mkTm({ tilesPerFrame: [0] }), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(120);
  sl.stop();
  const idle = sl.frameLog.filter((f) => f.idle).length;
  assert(idle >= FAST.idleThreshold, `idle frames ${idle}`);
  // after threshold, gap between frames should be ~idleInterval not activeInterval
  const last2 = sl.frameLog.slice(-2);
  if (last2.length === 2) {
    const gap = last2[1].t - last2[0].t;
    assert(gap >= FAST.idleInterval - 15, `gap ${gap}ms should approach idleInterval ${FAST.idleInterval}`);
  }
});

await test("L3 capture throw → retry after 200ms, loop survives", async () => {
  const sl = new StreamLoop({ tileManager: mkTm({ failOn: 1 }), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(500);
  sl.stop();
  assert(sl.retryCount >= 1, `expected retry, got ${sl.retryCount}`);
  assert(sl.frameLog.length >= 1, "loop resumed after throw");
});

await test("L4 backpressure: only sent tiles are committed", async () => {
  const tm = mkTm({ tilesPerFrame: [8] });
  const sl = new StreamLoop({ tileManager: tm, protocol: mkProtocol({ dropAfter: 3 }), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(80);
  sl.stop();
  assert(tm._committed.length > 0, "no commits");
  for (const c of tm._committed) {
    assert(c.length <= 3, `committed ${c.length} > 3 (should be only sent)`);
  }
});

await test("L5 stop() exits the loop (isStreaming guard)", async () => {
  const sl = new StreamLoop({ tileManager: mkTm(), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(40);
  sl.stop();
  const n = sl.frameLog.length;
  await sleep(80);
  assert(sl.frameLog.length === n, `loop kept running after stop (+${sl.frameLog.length - n})`);
  assert(sl.isStreaming === false, "isStreaming flag not cleared");
});

await test("L6 gen bump makes the old loop self-exit", async () => {
  const sl = new StreamLoop({ tileManager: mkTm(), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(30);
  const before = sl.frameLog.length;
  sl.bumpGen();
  await sleep(60);
  // after bump, the original loop's next tick should exit on gen mismatch
  assert(sl.exitReason === "gen" || sl.frameLog.length <= before + 2, "old loop did not exit on gen bump");
});

await test("L7 socket disconnect exits the loop", async () => {
  const sl = new StreamLoop({ tileManager: mkTm(), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(30);
  sl.disconnect();
  await sleep(60);
  assert(sl.exitReason === "disconnect", `exit ${sl.exitReason}`);
});

await test("L8 saturating timing: encode longer than activeInterval → nextInterval=0", async () => {
  const slow = mkTm();
  slow.detectChangedTilesWithHashes = async () => { await sleep(30); return { tiles: [1, 2].map((i) => ({ tileIndex: i, hash: i })), currentHashes: [] }; };
  const sl = new StreamLoop({ tileManager: slow, protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(120);
  sl.stop();
  const gaps = sl.frameLog.slice(1).map((f, i) => f.t - sl.frameLog[i].t);
  const minGap = Math.min(...gaps);
  // 30ms encode > 12ms active → nextInterval=0 → frames ~back-to-back (~30ms gap)
  assert(minGap < 45, `min gap ${minGap}ms — expected saturate (<45ms since encode=30ms)`);
});

await test("L9 sendTiles returning empty [] still commits [] (no resend storm)", async () => {
  const tm = mkTm({ tilesPerFrame: [4] });
  const proto = { sendTiles: () => [] };     // all dropped
  const sl = new StreamLoop({ tileManager: tm, protocol: proto, socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(60);
  sl.stop();
  assert(tm._committed.every((c) => c.length === 0), "empty commits expected");
});

await test("L10 frames stop accumulating after stop even under fast back-to-back", async () => {
  const sl = new StreamLoop({ tileManager: mkTm({ tilesPerFrame: [4] }), protocol: mkProtocol(), socket: mkSocket(), config: FAST });
  sl.start();
  await sleep(50);
  sl.stop();
  const n = sl.frameLog.length;
  await sleep(150);
  assert(sl.frameLog.length === n, `leaked frames after stop: +${sl.frameLog.length - n}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
