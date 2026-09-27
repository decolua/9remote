import http from "http";
import https from "https";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// A listening port is identified from the process behind it, not by knocking on it:
// probing every listener meant one idle database held the whole scan for its timeout.
// Only what the process cannot identify is probed.

export const CLASS = { WEB: "web", SERVICE: "service", UNKNOWN: "unknown" };

export const SITES_CACHE_TTL_MS = 8000;
// Generous because the probes run in parallel — the scan costs one timeout, not one
// per port — and a container-published port can take ~600ms to answer on a cold bridge.
const PROBE_TIMEOUT_MS = 800;
const EXEC_TIMEOUT_MS = 3000;
const MAX_PROBES = 24;

// Command lines that identify a web server outright.
const WEB_CMD = /\b(vite|next-server|next\s+(dev|start)|nuxt|astro|remix|gatsby|webpack(-dev-server)?|parcel|react-scripts|ng\s+serve|storybook|docusaurus|live-server|http-server|serve\b|python[\d.]*\s+-m\s+http\.server|gunicorn|uvicorn|hypercorn|flask|manage\.py\s+runserver|rails|puma|unicorn|thin|php\s+-S|artisan\s+serve|nginx|httpd|apache2?|caddy|jekyll|hugo|catalina|tomcat|spring)\b/i;

// Command lines that are never a web page, whatever port they hold.
const NON_WEB_CMD = /\b(postgres|postmaster|mysqld|mariadbd?|mongod|redis-server|memcached|elasticsearch|cassandra|clickhouse|etcd|zookeeper|kafka|rabbitmq|beam\.smp|sshd|rsync|smbd|nfsd|cupsd|rapportd|controlcenter|dnsmasq|named|ntpd|chronyd|dockerd|containerd|colima|qemu[\w-]*|netsimd|adb|emulator)\b/i;

// Ports owned by infrastructure. Kept separate from the command test so a service
// behind an opaque wrapper (a container runtime, a launcher) is still excluded.
const SERVICE_PORTS = new Set([
  22, 23, 25, 53, 110, 111, 135, 137, 138, 139, 143, 389, 445, 465, 548, 587, 631,
  993, 995, 1433, 1521, 2049, 2181, 3306, 3389, 5432, 5433, 5672, 5900, 6379,
  9092, 11211, 27017, 27018, 27019, 62078
]);

let cache = { at: 0, sites: null };

/** Drop the memoised scan (tests, and any caller that needs a forced refresh). */
export function invalidateSitesCache() {
  cache = { at: 0, sites: null };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Parse `lsof -F pcn` field output into one row per listening port. */
export function parseListeners(stdout) {
  const byPort = new Map();
  let pid = null;
  let command = "";
  for (const line of String(stdout || "").split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") {
      pid = Number(value) || null;
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n" && pid) {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      if (!port || port < 1 || port > 65535) continue;
      if (!byPort.has(port)) byPort.set(port, { pid, command, port });
    }
  }
  return [...byPort.values()];
}

/** Parse Windows `netstat -ano` LISTENING rows, named from `tasklist /fo csv /nh`. */
export function parseWinListeners(netstat, tasklist) {
  const names = new Map();
  for (const line of String(tasklist || "").split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 2) continue;
    const name = cols[0].slice(1, -1);
    const pid = Number(cols[1].slice(1, -1));
    if (pid) names.set(pid, name);
  }
  const byPort = new Map();
  for (const line of String(netstat || "").split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] || "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    const pid = Number(parts[parts.length - 1]);
    if (!port || port < 1 || port > 65535) continue;
    if (!byPort.has(port)) byPort.set(port, { pid: pid || null, command: names.get(pid) || "", port });
  }
  return [...byPort.values()];
}

/** Parse the batched `lsof -d cwd -F n` output into pid -> working directory. */
export function parseCwds(stdout) {
  const cwds = new Map();
  let pid = null;
  for (const line of String(stdout || "").split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") pid = Number(value) || null;
    else if (tag === "n" && pid) cwds.set(pid, value);
  }
  return cwds;
}

// ─── Classification ─────────────────────────────────────────────────────────

/** Decide from the command line whether a port serves a page, hosts a service, or needs probing. */
export function classifyProcess(cmdline, port) {
  const cmd = String(cmdline || "");
  if (WEB_CMD.test(cmd)) return CLASS.WEB;
  if (NON_WEB_CMD.test(cmd)) return CLASS.SERVICE;
  if (SERVICE_PORTS.has(port)) return CLASS.SERVICE;
  return CLASS.UNKNOWN;
}

/** Name a site after its package, then its folder, then its address. */
export function siteName({ pkgName, cwd, port }) {
  if (pkgName) return pkgName;
  const folder = cwd ? path.basename(cwd) : "";
  return folder || `localhost:${port}`;
}

// ─── Real IO ────────────────────────────────────────────────────────────────

const isWin = process.platform === "win32";

async function run(command) {
  const { stdout } = await execAsync(command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 8 });
  return stdout;
}

async function listListeners() {
  if (isWin) {
    const [netstat, tasklist] = await Promise.all([
      run("netstat -ano -p TCP").catch(() => ""),
      run("tasklist /fo csv /nh").catch(() => "")
    ]);
    return parseWinListeners(netstat, tasklist);
  }
  return parseListeners(await run("lsof -nP -iTCP -sTCP:LISTEN -F pcn"));
}

// Full command lines for every pid at once — one call, not one per port.
async function listCmdlines(pids) {
  if (isWin || !pids.length) return new Map();
  const stdout = await run(`ps -o pid=,command= -p ${pids.join(",")}`).catch(() => "");
  const map = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match) map.set(Number(match[1]), match[2]);
  }
  return map;
}

// Working directories for every pid at once — same batching rule as the command lines.
async function listCwds(pids) {
  if (isWin || !pids.length) return new Map();
  const stdout = await run(`lsof -a -d cwd -p ${pids.join(",")} -F n`).catch(() => "");
  return parseCwds(stdout);
}

function readPkgName(cwd) {
  if (!cwd) return null;
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
    const name = JSON.parse(raw)?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

function request(lib, port, extra) {
  return new Promise((resolve) => {
    const req = lib.request(
      { host: "localhost", port, method: "HEAD", path: "/", timeout: PROBE_TIMEOUT_MS, ...extra },
      (res) => {
        res.resume();
        resolve({ active: true, protocol: extra?.rejectUnauthorized === false ? "https" : "http", status: res.statusCode });
      }
    );
    req.on("error", (err) => resolve({ active: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ active: false, error: "timeout" }); });
    req.end();
  });
}

// HTTP first — a localhost dev server is plain HTTP almost always. The second
// request only happens when the failure names TLS: retrying every dead or
// non-HTTP port doubles the wait for ports that were never going to answer.
const TLS_ERROR = /EPROTO|SSL|wrong version number|packet length/i;

/** Whether a failed HTTP probe looks like TLS on the wire, and so is worth a second try. */
export function needsTlsRetry(error) {
  return TLS_ERROR.test(String(error || ""));
}

async function probePort(port) {
  const plain = await request(http, port);
  if (plain.active || !needsTlsRetry(plain.error)) return plain;
  return request(https, port, { rejectUnauthorized: false });
}

const realIo = {
  listeners: listListeners,
  cmdlines: listCmdlines,
  cwds: listCwds,
  probe: probePort,
  readPkgName
};

// ─── Scan ───────────────────────────────────────────────────────────────────

/**
 * List the local web servers worth offering. Memoised for SITES_CACHE_TTL_MS so
 * reopening the panel does not re-run the whole pipeline.
 */
export async function scanLocalSites({ io = realIo, now = Date.now } = {}) {
  if (cache.sites && now() - cache.at < SITES_CACHE_TTL_MS) return cache.sites;

  let sites = [];
  try {
    const rows = await io.listeners();
    const cmdlines = await io.cmdlines([...new Set(rows.map((r) => r.pid).filter(Boolean))]);

    const accepted = [];
    const unknown = [];
    for (const row of rows) {
      const cmd = cmdlines.get(row.pid) || row.command;
      const verdict = classifyProcess(cmd, row.port);
      if (verdict === CLASS.WEB) accepted.push({ ...row, protocol: "http", status: null });
      else if (verdict === CLASS.UNKNOWN) unknown.push(row);
    }

    // Bound the probe fan-out: a machine with hundreds of opaque listeners must not
    // turn the fallback path back into the cost this scan exists to avoid.
    const probes = await Promise.all(
      unknown.slice(0, MAX_PROBES).map(async (row) => ({ row, result: await io.probe(row.port) }))
    );
    for (const { row, result } of probes) {
      if (result?.active) accepted.push({ ...row, protocol: result.protocol || "http", status: result.status ?? null });
    }

    const cwds = await io.cwds([...new Set(accepted.map((r) => r.pid).filter(Boolean))]);
    sites = accepted
      .map((row) => {
        const cwd = cwds.get(row.pid) || null;
        return {
          port: row.port,
          protocol: row.protocol,
          url: `${row.protocol}://localhost:${row.port}`,
          name: siteName({ pkgName: io.readPkgName(cwd), cwd, port: row.port }),
          status: row.status
        };
      })
      .sort((a, b) => a.port - b.port);
  } catch (error) {
    console.error("Failed to scan local sites:", error.message);
    return [];
  }

  cache = { at: now(), sites };
  return sites;
}
