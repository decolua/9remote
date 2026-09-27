// Local-site detection. The property under test is that a port is classified from the
// process behind it, not by knocking on it: probing every listener is what made the
// sites list cost seconds on any machine running a database.
// Run: node agent/test/portScan.test.mjs
import assert from "node:assert/strict";
import {
  parseListeners, parseWinListeners, parseCwds, classifyProcess, siteName,
  scanLocalSites, invalidateSitesCache, needsTlsRetry, CLASS, SITES_CACHE_TTL_MS
} from "../features/terminal/portScanner.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ─── lsof -F pcn parsing ────────────────────────────────────────────────────

const LSOF = [
  "p466", "crapportd", "f15", "n*:52506",
  "p2098", "ccom.docker.backend", "f131", "n*:80", "f196", "n*:27017",
  "p5424", "cnode", "f18", "n[::1]:5173",
  "p5488", "ccloudflar", "f11", "n127.0.0.1:20241"
].join("\n");

await test("every listening port is read with the pid and command that owns it", () => {
  const rows = parseListeners(LSOF);
  assert.deepEqual(rows.find((r) => r.port === 5173), { pid: 5424, command: "node", port: 5173 });
  assert.deepEqual(rows.find((r) => r.port === 52506), { pid: 466, command: "rapportd", port: 52506 });
});

await test("one process listening on several ports yields one row per port", () => {
  const rows = parseListeners(LSOF).filter((r) => r.pid === 2098);
  assert.deepEqual(rows.map((r) => r.port).sort((a, b) => a - b), [80, 27017]);
});

await test("the same port on ipv4 and ipv6 collapses to a single row", () => {
  const dual = ["p900", "cnode", "f3", "n*:3000", "f4", "n127.0.0.1:3000"].join("\n");
  assert.equal(parseListeners(dual).length, 1);
});

await test("malformed or empty lsof output yields nothing rather than throwing", () => {
  assert.deepEqual(parseListeners(""), []);
  assert.deepEqual(parseListeners("garbage\nn*:notaport"), []);
});

// ─── Windows netstat + tasklist ─────────────────────────────────────────────

const NETSTAT = [
  "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321",
  "  TCP    [::]:5432              [::]:0                 LISTENING       900",
  "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4321",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4"
].join("\r\n");

const TASKLIST = [
  '"node.exe","4321","Console","1","120,000 K"',
  '"postgres.exe","900","Services","0","80,000 K"'
].join("\r\n");

await test("windows listeners come from netstat with names joined from tasklist", () => {
  const rows = parseWinListeners(NETSTAT, TASKLIST);
  assert.deepEqual(rows.find((r) => r.port === 3000), { pid: 4321, command: "node.exe", port: 3000 });
  assert.deepEqual(rows.find((r) => r.port === 5432), { pid: 900, command: "postgres.exe", port: 5432 });
});

await test("a pid tasklist does not know about still reports its port", () => {
  const row = parseWinListeners(NETSTAT, TASKLIST).find((r) => r.port === 445);
  assert.equal(row.pid, 4);
  assert.equal(row.command, "");
});

// ─── cwd batch parsing ──────────────────────────────────────────────────────

await test("the batched cwd lookup maps each pid to its directory", () => {
  const out = ["p5379", "fcwd", "n/Users/me/app", "p5424", "fcwd", "n/Users/me/site"].join("\n");
  const cwds = parseCwds(out);
  assert.equal(cwds.get(5379), "/Users/me/app");
  assert.equal(cwds.get(5424), "/Users/me/site");
});

// ─── classification ─────────────────────────────────────────────────────────

await test("a known dev server is accepted from its command line alone", () => {
  assert.equal(classifyProcess("node /app/node_modules/.bin/vite --port 5173", 5173), CLASS.WEB);
  assert.equal(classifyProcess("next-server (v15.0.0)", 3000), CLASS.WEB);
  assert.equal(classifyProcess("python3 -m http.server 8000", 8000), CLASS.WEB);
  assert.equal(classifyProcess("nginx: master process /usr/sbin/nginx", 80), CLASS.WEB);
});

await test("a database is rejected from its command line, never probed", () => {
  assert.equal(classifyProcess("/usr/local/bin/postgres -D /data", 5432), CLASS.SERVICE);
  assert.equal(classifyProcess("redis-server 127.0.0.1:6379", 6379), CLASS.SERVICE);
  assert.equal(classifyProcess("/usr/sbin/sshd -D", 22), CLASS.SERVICE);
});

await test("a service port is rejected even when the command line is unrecognisable", () => {
  assert.equal(classifyProcess("com.docker.backend", 27017), CLASS.SERVICE);
  assert.equal(classifyProcess("mystery", 3306), CLASS.SERVICE);
});

await test("an emulator or device bridge is rejected without a probe", () => {
  // These accept a connection and then say nothing — the exact shape that made
  // the old scan pay a full timeout per port.
  assert.equal(classifyProcess("/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64", 54896), CLASS.SERVICE);
  assert.equal(classifyProcess("adb -L tcp:5037 fork-server server", 5037), CLASS.SERVICE);
  assert.equal(classifyProcess("/Android/sdk/emulator/netsimd --host-dns=8.8.8.8", 6402), CLASS.SERVICE);
});

await test("https is retried only when the failure names tls", () => {
  // A dead or non-HTTP port must not pay a second timeout on the way out.
  assert.equal(needsTlsRetry("write EPROTO ... wrong version number"), true);
  assert.equal(needsTlsRetry("timeout"), false);
  assert.equal(needsTlsRetry("ECONNRESET"), false);
  assert.equal(needsTlsRetry("HPE_INVALID_CONSTANT"), false);
  assert.equal(needsTlsRetry(""), false);
});

await test("anything else stays unknown so the probe can settle it", () => {
  assert.equal(classifyProcess("./my-go-server", 8090), CLASS.UNKNOWN);
  assert.equal(classifyProcess("", 4000), CLASS.UNKNOWN);
  // Docker publishes container ports; a web container must not be hidden.
  assert.equal(classifyProcess("com.docker.backend", 80), CLASS.UNKNOWN);
});

// ─── naming ─────────────────────────────────────────────────────────────────

await test("a site is named after its package, then its folder, then its port", () => {
  assert.equal(siteName({ pkgName: "my-app", cwd: "/Users/me/src", port: 5173 }), "my-app");
  assert.equal(siteName({ pkgName: null, cwd: "/Users/me/src", port: 5173 }), "src");
  assert.equal(siteName({ pkgName: null, cwd: null, port: 5173 }), "localhost:5173");
});

// ─── scan ───────────────────────────────────────────────────────────────────

function fakeIo(overrides = {}) {
  const calls = { probed: [], cwds: [] };
  const io = {
    calls,
    listeners: async () => [
      { pid: 10, command: "node", port: 5173 },
      { pid: 20, command: "postgres", port: 5432 },
      { pid: 30, command: "weird", port: 8090 }
    ],
    cmdlines: async (pids) => new Map(pids.map((pid) => [pid, {
      10: "node /app/node_modules/.bin/vite",
      20: "/usr/local/bin/postgres -D /data",
      30: "./weird-server"
    }[pid] || ""])),
    cwds: async (pids) => { calls.cwds.push(pids); return new Map([[10, "/Users/me/my-app"]]); },
    probe: async (port) => { calls.probed.push(port); return { active: true, protocol: "http", status: 200 }; },
    readPkgName: () => "my-app",
    ...overrides
  };
  return io;
}

await test("a recognised dev server is reported without any probe", async () => {
  invalidateSitesCache();
  const io = fakeIo();
  const sites = await scanLocalSites({ io });
  const vite = sites.find((s) => s.port === 5173);
  assert.ok(vite, "the vite server is listed");
  assert.equal(vite.name, "my-app");
  assert.equal(vite.protocol, "http");
  assert.ok(!io.calls.probed.includes(5173), "no request was sent to a port already identified");
});

await test("a database never reaches the probe and never reaches the list", async () => {
  invalidateSitesCache();
  const io = fakeIo();
  const sites = await scanLocalSites({ io });
  assert.equal(sites.find((s) => s.port === 5432), undefined);
  assert.ok(!io.calls.probed.includes(5432), "the database port was not knocked on");
});

await test("only the unidentified port is probed", async () => {
  invalidateSitesCache();
  const io = fakeIo();
  await scanLocalSites({ io });
  assert.deepEqual(io.calls.probed, [8090]);
});

await test("an unidentified port that answers nothing is dropped", async () => {
  invalidateSitesCache();
  const io = fakeIo({ probe: async () => ({ active: false }) });
  const sites = await scanLocalSites({ io });
  assert.equal(sites.find((s) => s.port === 8090), undefined);
});

await test("results come back sorted by port", async () => {
  invalidateSitesCache();
  const sites = await scanLocalSites({ io: fakeIo() });
  assert.deepEqual(sites.map((s) => s.port), [...sites.map((s) => s.port)].sort((a, b) => a - b));
});

await test("the shape the clients already read is unchanged", async () => {
  invalidateSitesCache();
  const [site] = await scanLocalSites({ io: fakeIo() });
  assert.deepEqual(Object.keys(site).sort(), ["name", "port", "protocol", "status", "url"]);
  assert.equal(site.url, `${site.protocol}://localhost:${site.port}`);
});

await test("a scan within the cache window reuses the last result", async () => {
  invalidateSitesCache();
  let scans = 0;
  const io = fakeIo({ listeners: async () => { scans++; return [{ pid: 10, command: "node", port: 5173 }]; } });
  let clock = 1000;
  const now = () => clock;
  await scanLocalSites({ io, now });
  await scanLocalSites({ io, now });
  assert.equal(scans, 1, "the second open reused the cached list");
  clock += SITES_CACHE_TTL_MS + 1;
  await scanLocalSites({ io, now });
  assert.equal(scans, 2, "once stale, it scans again");
});

await test("a failing lsof yields an empty list rather than an exception", async () => {
  invalidateSitesCache();
  const io = fakeIo({ listeners: async () => { throw new Error("lsof: not found"); } });
  assert.deepEqual(await scanLocalSites({ io }), []);
});

await test("the cwd lookup is one batched call, not one per port", async () => {
  invalidateSitesCache();
  const io = fakeIo();
  await scanLocalSites({ io });
  assert.equal(io.calls.cwds.length, 1, "a single batched cwd call");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
