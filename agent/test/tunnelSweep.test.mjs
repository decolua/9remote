// Stale-tunnel sweep: a 9remote start must not leave a previous cloudflared
// holding its edge connection — on quick tunnels that connection also holds a
// trycloudflare slot, so leftovers are what starve the next start of quota
// (observed: a day-old cloudflared from a dead instance still alive, the pid
// file pointing at a third, unrelated pid).
//
// The load-bearing rule here is IDENTIFICATION. pids.js states it for the update
// path and it applies just as much to a runtime sweep: never match by image name,
// because a user's own `cloudflared` (brew, a named tunnel for another service)
// is a different program that happens to share a binary name. We match the binary
// WE manage plus the `tunnel` subcommand.
//
// Run: node agent/test/tunnelSweep.test.mjs
import assert from "node:assert/strict";
import { parsePsOutput, pickStalePids } from "../cli/utils/cloudflared.js";

const BIN = "/Users/x/.9remote/bin/cloudflared";
const OUR_CMD = `${BIN} tunnel --url http://localhost:2208 --no-autoupdate --protocol http2`;

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── parsePsOutput ──────────────────────────────────────────────────────────

test("parses `ps -eo pid=,args=` rows into pid + argv", () => {
  const out = `  123 ${OUR_CMD}\n  456 /usr/bin/something else\n`;
  assert.deepEqual(parsePsOutput(out), [
    { pid: 123, args: OUR_CMD },
    { pid: 456, args: "/usr/bin/something else" },
  ]);
});

test("drops blank lines and rows without a numeric pid", () => {
  assert.deepEqual(parsePsOutput("\n   \nPID ARGS\n 789 ok\n"), [{ pid: 789, args: "ok" }]);
});

test("keeps a command line containing spaces intact", () => {
  const cmd = "/Users/a b/.9remote/bin/cloudflared tunnel --url http://localhost:2208";
  assert.deepEqual(parsePsOutput(`  10 ${cmd}`), [{ pid: 10, args: cmd }]);
});

test("empty output yields an empty list", () => {
  assert.deepEqual(parsePsOutput(""), []);
  assert.deepEqual(parsePsOutput(null), []);
});

// ── Identification: which processes are OURS ───────────────────────────────

test("a cloudflared launched from our managed binary is ours", () => {
  const procs = [{ pid: 100, args: OUR_CMD }];
  assert.deepEqual(pickStalePids(procs, BIN), [100]);
});

test("a user's own cloudflared from another path is NOT ours", () => {
  // The whole point: same image name, different program. Killing it would take
  // down a tunnel 9remote never owned.
  const procs = [
    { pid: 200, args: "/opt/homebrew/bin/cloudflared tunnel run --token eyJh" },
    { pid: 201, args: "/usr/local/bin/cloudflared tunnel --url http://localhost:3000" },
  ];
  assert.deepEqual(pickStalePids(procs, BIN), []);
});

test("a sibling binary sharing our path prefix is NOT ours", () => {
  // startsWith(binaryPath) alone would match; the token check rejects it.
  const procs = [{ pid: 300, args: `${BIN}-wrapper tunnel --url http://localhost:2208` }];
  assert.deepEqual(pickStalePids(procs, BIN), []);
});

test("our binary invoked for something other than `tunnel` is NOT ours", () => {
  const procs = [
    { pid: 301, args: `${BIN} --version` },
    { pid: 302, args: `${BIN} update` },
  ];
  assert.deepEqual(pickStalePids(procs, BIN), []);
});

test("unrelated processes are NOT ours", () => {
  const procs = [
    { pid: 400, args: "/usr/bin/node /Users/Working/9remote/agent/index.js" },
    { pid: 401, args: "/Users/x/.9remote/bin/someothertool tunnel" },
  ];
  assert.deepEqual(pickStalePids(procs, BIN), []);
});

// ── The real-world case this exists for ────────────────────────────────────

test("sweeps both leftovers while leaving unrelated tunnels alone", () => {
  const procs = [
    { pid: 30027, args: OUR_CMD },                                   // leftover from a killed instance
    { pid: 93753, args: OUR_CMD },                                   // day-old leftover
    { pid: 6710, args: "/usr/local/bin/node /usr/local/lib/node_modules/9remote/dist/cli.cjs ui --start" },
    { pid: 89915, args: "/opt/homebrew/bin/cloudflared tunnel run --token eyJh" },
  ];
  assert.deepEqual(pickStalePids(procs, BIN), [30027, 93753]);
});

test("nothing to sweep is a clean no-op", () => {
  assert.deepEqual(pickStalePids([], BIN), []);
  assert.deepEqual(pickStalePids(null, BIN), []);
});

test("a malformed process row never throws", () => {
  const procs = [{ pid: 800, args: null }, { pid: 801, args: "" }, { pid: 802 }, null];
  assert.deepEqual(pickStalePids(procs, BIN), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
