// Spawn the native DXGI DDA probe and parse its output. Throws on any failure
// (caller falls back). Lines of interest:
//   "output0: WxH (Xmb raw)"
//   "A) ... median=0.305ms min=0.151 max=..."
//   "   WAIT_TIMEOUT (no change): N/30 frames w/ new content: M/30"
import { spawnSync } from "child_process";

export function runDxgiProbe(exePath, { log } = {}) {
  if (!exePath) throw new Error("probe exe not built");
  const r = spawnSync(exePath, [], { encoding: "utf8", windowsHide: true, timeout: 90000 });
  if (r.error) throw r.error;
  if (!r.stdout) throw new Error(`probe exit ${r.status} stderr=${r.stderr?.slice(0, 200)}`);
  return parseDxgiOutput(r.stdout);
}

function grabMs(line, key) {
  const m = line.match(new RegExp(`${key}=([0-9.]+)ms`));
  return m ? +m[1] : null;
}

export function parseDxgiOutput(stdout) {
  const out = { resolution: null, phaseA: null, phaseB: null, phaseC: null, raw: stdout };
  const lines = stdout.split(/\r?\n/);
  let current = null;
  for (const ln of lines) {
    const res = ln.match(/output\d+:\s*(\d+)x(\d+)/);
    if (res) out.resolution = { w: +res[1], h: +res[2] };
    if (/^[ABC]\)/.test(ln.trim())) {
      const id = ln.trim()[0];
      current = id;
      if (!out[`phase${id}`]) out[`phase${id}`] = {};
    }
    if (current) {
      const med = grabMs(ln, "median");
      const min = grabMs(ln, "min");
      const max = grabMs(ln, "max");
      if (med !== null) Object.assign(out[`phase${current}`], { median: med, min, max });
      const to = ln.match(/WAIT_TIMEOUT[^:]*:\s*(\d+)\/\d+.*new content:\s*(\d+)\/(\d+)/);
      if (to) out[`phase${current}`].timeouts = +to[1], out[`phase${current}`].newContent = +to[2], out[`phase${current}`].total = +to[3];
      const nc = ln.match(/frames w\/ new content:\s*(\d+)\/(\d+)/);
      if (nc && !out[`phase${current}`].newContent) out[`phase${current}`].newContent = +nc[1], out[`phase${current}`].total = +nc[2];
    }
  }
  return out;
}
