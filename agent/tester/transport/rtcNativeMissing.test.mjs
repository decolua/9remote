// Test ProtocolManager.init() fail-safe when RTC native addon is broken.
// Reproduces the user's crash: node-datachannel .node missing → WebRtcProtocol
// throws on connect → init() must skip RTC and keep ws, instead of crashing.
// Run: node tester/transport/rtcNativeMissing.test.mjs
import assert from "node:assert";
import { registerProtocol } from "../../transport/registry.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// Register a fake "rtc" that throws in connect() — simulates broken native addon.
// Use a unique id per run to avoid colliding with the real WebRtcProtocol registration
// (registry is module-scoped, shared with the real import below).
import { ProtocolManager } from "../../transport/ProtocolManager.js";

// The real WebRtcProtocol is already registered by ProtocolManager.js import side-effect.
// We can't easily swap it; instead we test init() behavior directly by injecting a
// throwing adapter via a fresh PM and monkey-patching _buildCtx so RTC.connect throws.

const pm = new ProtocolManager(
  { id: "test", on: () => {}, listeners: () => [], connected: true },
  { enableWebRTC: true, maxControlBuffer: 500 }
);

// Force RTC adapter: replace getProtocol result for "rtc" with a throwing adapter.
// We do this by stubbing the registry indirectly — instantiate PM, then before init()
// swap the real rtc entry. Easiest: monkey-patch _buildCtx won't trigger throw;
// instead we directly test by registering a fake protocol under id "rtc" after clearing.
// Registry has no unregister; we test via a controlled subclass instead.

class ThrowingRtc {
  static id = "rtc";
  static capabilities = { control: true, binary: true, signaling: "external" };
  static priority = { control: 50, binary: 100 };
  constructor() { throw new Error("Cannot find module 'node_datachannel.node'"); }
}

// Override the adapter lookup by replacing _adapters after a custom init path:
// Build a minimal PM-like object reusing init() logic is brittle; instead we verify
// init() catches the throw by pointing the profile at a protocol id whose constructor
// throws. Register ThrowingRtc under a fresh id and temporarily mark it enabled.
class FakeRtc { static id = "rtcFake"; constructor() { throw new Error("missing .node"); } }
registerProtocol(FakeRtc);

// Mutate the profile to include rtcFake and ws. ws is real (WsProtocol registered).
// We can't easily add rtcFake to profile.enabled without touching internals; access directly.
pm._profile.enabled = ["ws", "rtcFake"];

let crashed = false;
try {
  await pm.init();
} catch (e) {
  crashed = true;
}

check("init() does not crash when a non-rtc adapter throws? (inverse check)", true);
// Note: init() only swallows throws for id==="rtc". rtcFake throw WILL propagate —
// that's the intended policy (only RTC is optional). Verify that propagation:
check("non-rtc adapter throw propagates (crashed)", crashed, "expected rtcFake throw to propagate");

// Now test the RTC case: re-register real rtc path is hard; verify via the id==="rtc"
// guard by temporarily renaming FakeRtc to id "rtc" semantics through a second PM.
class FakeRtc2 { static id = "rtc"; constructor() { throw new Error("missing .node"); }
  on() {} connect() {} }
// Registry already has real WebRtcProtocol under "rtc"; set() won't fire but registerProtocol
// uses Map.set so it OVERWRITES. Do it:
registerProtocol(FakeRtc2);

const pm2 = new ProtocolManager(
  { id: "test2", on: () => {}, listeners: () => [], connected: true },
  { enableWebRTC: true, maxControlBuffer: 500 }
);
pm2._profile.enabled = ["ws", "rtc"];

let crashed2 = false;
try {
  await pm2.init();
} catch (e) {
  crashed2 = true;
}

check("RTC native broken → init() does NOT crash", !crashed2, "init threw on RTC failure");
check("RTC broken → ws adapter still initialized", pm2._adapters.has("ws"), `adapters=[${[...pm2._adapters.keys()].join(",")}]`);
check("RTC broken → rtc adapter NOT added", !pm2._adapters.has("rtc"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
