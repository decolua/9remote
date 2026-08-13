// Tests for the standalone STUN probe used to lift an RTC give-up.
// The give-up must only be lifted on EVIDENCE (a different public IP), never on
// a timer — otherwise every long app switch re-spams the DO with offers the same
// NAT will refuse again. These tests pin that rule and the probe's failure modes.
//
// Run: node web/test/stunProbe.test.mjs
import assert from "node:assert/strict";
import { srflxIpOf, shouldRearmOnIpChange, probePublicIp, NO_PUBLIC_IP } from "../shared/transport/stunProbe.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// ── srflxIpOf ──────────────────────────────────────────────────────────────
const SRFLX = "candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.5 rport 54321";
const HOST = "candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0";
const RELAY = "candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 54321";

const tests = [
  test("extracts the public IP from an srflx candidate", () => {
    assert.equal(srflxIpOf(SRFLX), "203.0.113.7");
  }),

  test("host candidate yields no public IP (LAN address is not evidence)", () => {
    assert.equal(srflxIpOf(HOST), null);
  }),

  test("relay candidate is not srflx — no public IP claimed", () => {
    assert.equal(srflxIpOf(RELAY), null);
  }),

  test("malformed / empty input never throws", () => {
    assert.equal(srflxIpOf(null), null);
    assert.equal(srflxIpOf(""), null);
    assert.equal(srflxIpOf("garbage"), null);
  }),

  test("IPv6 srflx candidate is extracted too (dual-stack networks)", () => {
    const v6 = "candidate:2 1 udp 1686052607 2001:db8::1 54321 typ srflx raddr :: rport 0";
    assert.equal(srflxIpOf(v6), "2001:db8::1");
  }),

  // ── shouldRearmOnIpChange — the money rule ───────────────────────────────
  test("same public IP → do NOT re-arm (network never moved, don't spam DO)", () => {
    assert.equal(shouldRearmOnIpChange("203.0.113.7", "203.0.113.7"), false);
  }),

  test("different public IP → re-arm (real handover, NAT may differ now)", () => {
    assert.equal(shouldRearmOnIpChange("203.0.113.7", "198.51.100.4"), true);
  }),

  test("probe failed (null) → do NOT re-arm (no evidence beats a guess)", () => {
    assert.equal(shouldRearmOnIpChange("203.0.113.7", null), false);
  }),

  test("no previous IP recorded → allow one attempt (can't rule out a change)", () => {
    assert.equal(shouldRearmOnIpChange(null, "203.0.113.7"), true);
  }),

  test("both unknown → do NOT re-arm", () => {
    assert.equal(shouldRearmOnIpChange(null, null), false);
  }),

  test("STUN-blocked network keeps a stable baseline (no re-arm loop)", () => {
    // UDP blocked on both sides of the resume: caller maps a failed probe to
    // NO_PUBLIC_IP when that was the baseline, so it must read as unchanged.
    assert.equal(shouldRearmOnIpChange(NO_PUBLIC_IP, NO_PUBLIC_IP), false);
  }),

  test("STUN-blocked → later gets a public IP → re-arm (network really changed)", () => {
    assert.equal(shouldRearmOnIpChange(NO_PUBLIC_IP, "203.0.113.7"), true);
  }),

  test("had a public IP → now STUN-blocked → re-arm (different network)", () => {
    assert.equal(shouldRearmOnIpChange("203.0.113.7", NO_PUBLIC_IP), true);
  }),

  test("NO_PUBLIC_IP can never collide with a real IP", () => {
    // Must not parse as IPv4/IPv6 — otherwise a real address could equal the
    // marker and a genuine handover would read as "unchanged".
    assert.ok(!/^[0-9.]+$/.test(NO_PUBLIC_IP), "marker must not look like IPv4");
    assert.ok(!/^[0-9a-fA-F:]+$/.test(NO_PUBLIC_IP), "marker must not look like IPv6");
    assert.ok(NO_PUBLIC_IP.length > 0);
  }),

  // ── probePublicIp with a fake RTCPeerConnection ──────────────────────────
  test("resolves the srflx IP as soon as one is gathered", async () => {
    const ip = await probePublicIp({ PeerConnection: fakePC([SRFLX]), timeoutMs: 500 });
    assert.equal(ip, "203.0.113.7");
  }),

  test("ignores host candidates and waits for the srflx one", async () => {
    const ip = await probePublicIp({ PeerConnection: fakePC([HOST, HOST, SRFLX]), timeoutMs: 500 });
    assert.equal(ip, "203.0.113.7");
  }),

  test("gathering ends with no srflx (UDP blocked) → null, not a hang", async () => {
    const ip = await probePublicIp({ PeerConnection: fakePC([HOST, null]), timeoutMs: 500 });
    assert.equal(ip, null);
  }),

  test("no candidates at all → resolves null on timeout, never hangs", async () => {
    const t0 = Date.now();
    const ip = await probePublicIp({ PeerConnection: fakePC([]), timeoutMs: 120 });
    assert.equal(ip, null);
    assert.ok(Date.now() - t0 < 1000, "must resolve via timeout, not hang");
  }),

  test("constructor throwing (no WebRTC) → null, never rejects", async () => {
    const Boom = function () { throw new Error("no webrtc"); };
    const ip = await probePublicIp({ PeerConnection: Boom, timeoutMs: 100 });
    assert.equal(ip, null);
  }),

  test("createOffer rejecting → null, never rejects", async () => {
    const PC = fakePC([SRFLX], { failOffer: true });
    const ip = await probePublicIp({ PeerConnection: PC, timeoutMs: 300 });
    assert.equal(ip, null);
  }),

  test("closes the peer connection so the probe leaks nothing", async () => {
    const closed = { count: 0 };
    await probePublicIp({ PeerConnection: fakePC([SRFLX], { closed }), timeoutMs: 300 });
    assert.equal(closed.count, 1);
  }),

  test("missing RTCPeerConnection entirely → null (SSR / old WebView safe)", async () => {
    const ip = await probePublicIp({ PeerConnection: null, timeoutMs: 100 });
    assert.equal(ip, null);
  }),
];

// Fake RTCPeerConnection: emits the given candidate lines (null = end-of-gathering).
function fakePC(candidates, { failOffer = false, closed } = {}) {
  return function FakePC() {
    const self = this;
    this.onicecandidate = null;
    this.createDataChannel = () => ({});
    this.close = () => { if (closed) closed.count++; };
    this.setLocalDescription = () => Promise.resolve();
    this.createOffer = () => {
      if (failOffer) return Promise.reject(new Error("offer failed"));
      setTimeout(() => {
        for (const c of candidates) {
          if (!self.onicecandidate) return;
          self.onicecandidate({ candidate: c == null ? null : { candidate: c } });
        }
      }, 5);
      return Promise.resolve({ type: "offer", sdp: "" });
    };
  };
}

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
