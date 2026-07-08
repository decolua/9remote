// PoC: robotjs capture in worker_threads — feasibility + event-loop block benchmark.
// Standalone. Not imported by app. Delete after reading numbers.
// Run: node agent/tester/remote/workerCapturePoc.mjs
import { Worker, isMainThread, parentPort } from "worker_threads";
import { performance } from "perf_hooks";

const ITER = 30;

async function loadRobot() {
  const mod = await import("@hurdlegroup/robotjs");
  return mod.default || mod;
}

function captureOnce(robot) {
  const { width, height } = robot.getScreenSize();
  const bmp = robot.screen.capture(0, 0, width, height);
  // Mirror app: copy native buffer out (captureAdapter.js:42)
  const buf = Buffer.from(bmp.image);
  return { bytes: buf.length, width: bmp.byteWidth / bmp.bytesPerPixel, height: bmp.height };
}

// ─── Worker branch ───────────────────────────────────────────────
if (!isMainThread) {
  try {
    const robot = await loadRobot();
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      const r = captureOnce(robot);
      times.push(performance.now() - t);
      if (i === 0) parentPort.postMessage({ type: "info", ...r });
    }
    parentPort.postMessage({ type: "done", times });
  } catch (err) {
    parentPort.postMessage({ type: "error", message: err.message });
  }
  // stop worker
} else {
  // ─── Main branch ───────────────────────────────────────────────
  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return { avg: sum / s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
  };
  const fmt = (o) => `avg=${o.avg.toFixed(1)}ms p50=${o.p50.toFixed(1)} p95=${o.p95.toFixed(1)} max=${o.max.toFixed(1)}`;

  // Event-loop lag probe: schedule setInterval(0), measure actual delay vs expected.
  function startLagProbe(expectedMs = 5) {
    const lags = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      lags.push(now - last - expectedMs);
      last = now;
    }, expectedMs);
    return { stop: () => { clearInterval(timer); return lags; }, };
  }

  // ── Test A: capture on MAIN thread, measure event-loop lag during it ──
  console.log("=== Test A: capture on MAIN thread ===");
  const robot = await loadRobot();
  {
    const probe = startLagProbe(5);
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t = performance.now();
      captureOnce(robot);
      times.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 20)); // mimic frame gap
    }
    const lags = probe.stop();
    console.log(`  capture block : ${fmt(stats(times))}`);
    console.log(`  loop lag      : ${fmt(stats(lags))}  ← main blocked = high lag`);
  }

  // ── Test B: capture on WORKER thread, measure MAIN loop lag in parallel ──
  console.log("\n=== Test B: capture on WORKER thread ===");
  await new Promise((resolve) => {
    const probe = startLagProbe(5);
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", (msg) => {
      if (msg.type === "info") console.log(`  frame         : ${msg.width}x${msg.height} ${(msg.bytes / 1048576).toFixed(1)}MB`);
      else if (msg.type === "error") { console.log(`  WORKER FAIL   : ${msg.message}  ← robotjs không chạy trong worker`); worker.terminate(); const lags = probe.stop(); console.log(`  loop lag      : ${fmt(stats(lags))}`); resolve(); }
      else if (msg.type === "done") {
        const lags = probe.stop();
        console.log(`  capture block : ${fmt(stats(msg.times))}  (in worker, không ảnh hưởng main)`);
        console.log(`  loop lag MAIN : ${fmt(stats(lags))}  ← main rảnh = lag thấp`);
        worker.terminate();
        resolve();
      }
    });
    worker.on("error", (err) => { console.log(`  WORKER ERROR  : ${err.message}`); probe.stop(); resolve(); });
  });

  console.log("\n=== Kết luận ===");
  console.log("So loop lag A vs B: nếu B thấp hơn A rõ rệt → worker giải phóng event loop (input/RTC mượt).");
  console.log("Nếu Test B in WORKER FAIL → robotjs không load được trong worker → hướng worker chết.");
}
