// TDD test: WS zombie recovery on app resume (background → foreground).
//
// Symptom (user): switching apps (e.g. to YouTube) for a while, then returning,
// leaves everything dead — terminal doesn't load, remote is black, NO disconnect
// modal shows, menu shows "ws" (not rtc), and only an app reload fixes it.
//
// Root cause: socket.io reports connected=true after OS suspend even though the
// transport is dead (pings froze). WS "ready" stays true → onDisconnect never
// fires → no retry → no modal → data never flows. The visibility handler only
// health-checks RTC and trusts ws.ready, so it never probes a zombie WS.
//
// Two-layer test:
//   Layer 1 — pure helper isWsZombie(): threshold logic, directly importable.
//   Layer 2 — source contract: ProtocolManager wires the helper into its
//             visibility handler + stamps _lastInboundAt on ws inbound.
//
// Run: node web/test/wsZombieResume.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
};

// Alias "@/..." → web/ for pure-node import (Next.js resolves it at build time).
const REPO = new URL("../../", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`
  export function resolve(specifier, ctx, next) {
    if (specifier.startsWith("@/")) {
      let s = "${REPO}web/" + specifier.slice(2);
      if (!s.endsWith(".js")) s += ".js";
      return next(s, ctx);
    }
    return next(specifier, ctx);
  }
`), import.meta.url);

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PM_SRC = readFileSync(__dirname + "../shared/transport/ProtocolManager.js", "utf8");
const WS_SRC = readFileSync(__dirname + "../shared/transport/WsProtocol.js", "utf8");

// ---------------------------------------------------------------------------
// Layer 1 — pure helper. Import the real module (pure JS, dep is constants only).
// ---------------------------------------------------------------------------
const { isWsZombie } = await import("../shared/transport/wsZombie.js");

await test("isWsZombie: no inbound for 60s → true (zombie)", () => {
  assert.equal(isWsZombie({ lastInboundAt: 1000, now: 1000 + 60_000 }), true);
});

await test("isWsZombie: recent inbound (2s) → false (healthy)", () => {
  assert.equal(isWsZombie({ lastInboundAt: 1000, now: 1000 + 2_000 }), false);
});

await test("isWsZombie: exactly at threshold (45s) → true", () => {
  assert.equal(isWsZombie({ lastInboundAt: 1000, now: 1000 + 45_000 }), true);
});

await test("isWsZombie: just under threshold (44s) → false", () => {
  assert.equal(isWsZombie({ lastInboundAt: 1000, now: 1000 + 44_000 }), false);
});

await test("isWsZombie: never received (lastInboundAt=0) → true", () => {
  // 0 = no inbound ever recorded since PM constructed → suspect zombie on resume
  assert.equal(isWsZombie({ lastInboundAt: 0, now: 50_000 }), true);
});

await test("isWsZombie: ready=false short-circuits → false (not PM's job)", () => {
  // A WS that openly reports not-ready is handled by the normal retry path;
  // zombie probe only targets sockets that LOOK alive.
  assert.equal(isWsZombie({ ready: false, lastInboundAt: 1000, now: 1000 + 60_000 }), false);
});

// ---------------------------------------------------------------------------
// Layer 2 — source contract: PM must wire the helper + track inbound.
// ---------------------------------------------------------------------------
await test("source: PM imports isWsZombie from wsZombie.js", () => {
  assert.match(PM_SRC, /isWsZombie/, "PM must reference isWsZombie");
});

await test("source: WsProtocol stamps lastInboundAt on Engine.IO pong (true liveness)", () => {
  // socket.io "pong" arrives every pingInterval even with zero app traffic, so an
  // idle-but-alive socket is never mistaken for a zombie.
  // Require an actual event listener registration (socket.io / engine .on "pong"),
  // not just a bare string — guards against the listener being removed.
  assert.match(WS_SRC, /\.on.{0,5}\(["']pong["']/, "WsProtocol must register a pong event listener");
  assert.match(WS_SRC, /get lastInboundAt/, "WsProtocol must expose lastInboundAt getter for PM");
});

await test("source: PM reads liveness from ws.lastInboundAt (not app dispatch)", () => {
  // Liveness must NOT depend on app bytes (RTC owns binary; WS may be idle). PM
  // reads ws.lastInboundAt which is driven by Engine.IO pong.
  assert.match(PM_SRC, /ws\.lastInboundAt/, "PM must read lastInboundAt from the ws adapter");
});

await test("source: visibility handler probes WS zombie AND forces reconnect", () => {
  assert.match(PM_SRC, /isWsZombie/, "visibility handler must call isWsZombie");
  assert.match(PM_SRC, /forceReconnect/, "visibility handler must force-reconnect zombie WS");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
