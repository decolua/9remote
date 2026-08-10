// Spec test for the signaling carrier-routing logic mirrored in both
// ProtocolManagers (web + agent). Pure — no network, no imports (avoids @/ alias).
// Asserts which carrier (ws | do | null) is chosen for every readiness combo.
//
// The PMs implement this inline as:
//   const ws = this._adapters.get("ws");
//   if (ws?.ready && ws.send(...)) return;        // ws primary
//   if (this._sig?.ready && this._sig.send(msg)) return;  // do fallback
//   → drop
// If this test and the PM diverge, the PM is wrong.
//
// Run: node web/test/signaling-routing.test.mjs

function pickCarrier(wsReady, doReady) {
  if (wsReady) return "ws";      // tunnel primary
  if (doReady) return "do";      // DO fallback
  return null;                   // dropped
}

let pass = 0, fail = 0;
const assert = (cond, label) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  cond ? pass++ : fail++;
};

assert(pickCarrier(true, true) === "ws", "both ready → ws (primary)");
assert(pickCarrier(true, false) === "ws", "ws ready, do down → ws");
assert(pickCarrier(false, true) === "do", "ws down → do fallback");
assert(pickCarrier(false, false) === null, "both down → drop");

// The PM checks ws first ALWAYS (no config flip) — DO is pure fallback.
// This is the "tunnel sống → ws, tunnel chết → DO" contract.
assert(pickCarrier(false, false) !== "ws", "never pick ws when not ready");
assert(pickCarrier(false, false) !== "do", "never pick do when not ready");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
