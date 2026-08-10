// Spec test for SignalingClient reconnect decision + agent device-approval guard.
// Pure — mirrors the logic in SignalingClient._onClose and ProtocolManager's DO
// offer guard without importing the modules (avoids @/ alias + WS global).
//
// SignalingClient._onClose:
//   if (closed) return STOP                 // intentional disconnect
//   if (!openedOnce) { preOpenFails++; if (> MAX) return STOP }  // pre-open cap
//   return RECONNECT
//
// Agent PM DO guard (bypass-tunnel device approval re-check):
//   if (msg.type === "offer" && !approved(deviceId)) → reject + send error
//
// Run: node web/test/signaling-reconnect.test.mjs

const MAX_PRE_OPEN_FAILURES = 5;

// Mirror of SignalingClient._onClose decision. Returns "reconnect" | "stop".
// Mutates state.preOpenFails to mirror the real counter increment.
function decideReconnect(state) {
  if (state.closed) return "stop";
  if (!state.openedOnce) {
    state.preOpenFails++;
    if (state.preOpenFails > MAX_PRE_OPEN_FAILURES) return "stop";
  }
  return "reconnect";
}

// Mirror of agent PM DO inbound offer guard.
// Returns {forward: bool, error: string|null}.
function guardOffer(msg, approved) {
  if (msg.type === "offer" && !approved) {
    return { forward: false, error: "device not approved" };
  }
  return { forward: true, error: null };
}

let pass = 0, fail = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  cond ? pass++ : fail++;
};

// ── Reconnect decisions ──
assert(decideReconnect({ closed: true, openedOnce: false, preOpenFails: 0 }) === "stop",
  "intentional close → stop (never reconnect)");

assert(decideReconnect({ closed: false, openedOnce: true, preOpenFails: 0 }) === "reconnect",
  "post-open close → reconnect (no cap)");

// Pre-open: counts up, reconnects until cap
let st = { closed: false, openedOnce: false, preOpenFails: 0 };
let results = [];
for (let i = 0; i < MAX_PRE_OPEN_FAILURES + 2; i++) results.push(decideReconnect(st));
const reconnectCount = results.filter((r) => r === "reconnect").length;
const stopCount = results.filter((r) => r === "stop").length;
assert(reconnectCount === MAX_PRE_OPEN_FAILURES, `pre-open reconnects ${MAX_PRE_OPEN_FAILURES} times then stops`);
assert(stopCount === 2, "stops after cap exceeded (every subsequent close)");

// Once opened, pre-open counter irrelevant
st = { closed: false, openedOnce: true, preOpenFails: 99 };
assert(decideReconnect(st) === "reconnect", "openedOnce bypasses pre-open fail count");

// ── Device approval guard (DO path) ──
const okOffer = guardOffer({ type: "offer", sdp: "x" }, true);
assert(okOffer.forward === true && okOffer.error === null, "approved device offer → forward");

const blockedOffer = guardOffer({ type: "offer", sdp: "x" }, false);
assert(blockedOffer.forward === false && blockedOffer.error === "device not approved",
  "unapproved device offer → reject + error");

// Non-offer messages always forward (ICE/answer/error) — only offer initiates a session
const iceUnapproved = guardOffer({ type: "ice", candidate: "x" }, false);
assert(iceUnapproved.forward === true, "ICE from unapproved → forward (no session init)");

const answerUnapproved = guardOffer({ type: "answer", sdp: "x" }, false);
assert(answerUnapproved.forward === true, "answer from unapproved → forward (rare, harmless)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
