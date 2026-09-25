// Disconnect must stick: the liveness probe answers "is the machine up", and a
// YES must never resurrect a host the user turned off. The probe only asks about
// hosts with a standing connect intent.

import assert from "node:assert/strict";
import { HostRegistry, savedConnectedHeads } from "../shared/transport/hostRegistry.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("\n--- Disconnect intent vs liveness probe ---");

// Minimal browser surface the registry touches. `window` matters: the readers
// bail out without it (typeof window === "undefined"), which would silently
// make every probe assertion vacuous.
const store = new Map();
globalThis.window = globalThis.window || {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const CONNECTED_KEY = "9remote_fleet_connected";
const HEAD = "headB";
const CURRENT = "headA";

const makeRegistry = (probed) => new HostRegistry({
  hostOf: (h) => (h === HEAD ? { status: "offline", full: "k2" } : { status: "full", full: "k1" }),
  patch: () => {},
  bindBus: () => {},
  ready: () => {},
  // Mirrors the store's rule: only hosts the user still wants connected.
  probeTargets: () => {
    const wanted = new Set(savedConnectedHeads());
    return [HEAD, CURRENT].filter((h) => h !== CURRENT && wanted.has(h));
  }
});

await test("no standing intent → probe asks about nobody (no fetch at all)", async () => {
  store.clear();
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, json: async () => ({ hosts: {} }) }; };
  makeRegistry().probeOnce();
  assert.equal(fetched, 0, "a host with no connect intent must never be probed");
});

await test("standing intent → probe asks about that host", async () => {
  store.clear();
  localStorage.setItem(CONNECTED_KEY, JSON.stringify([HEAD]));
  let body = null;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ hosts: { [HEAD]: { online: true } } }) };
  };
  makeRegistry().probeOnce();
  // probeOnce fetches in a floating promise — wait until it actually ran.
  for (let i = 0; i < 10 && body === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(body?.heads, [HEAD]);
});

await test("disconnect clears the intent, so the next probe skips it", async () => {
  store.clear();
  localStorage.setItem(CONNECTED_KEY, JSON.stringify([HEAD]));
  const reg = makeRegistry();
  reg.persistIntent(HEAD, false); // what disconnectHost() does
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, json: async () => ({ hosts: {} }) }; };
  reg.probeOnce();
  assert.equal(fetched, 0, "a disconnected host must not be probed back to life");
  assert.deepEqual(savedConnectedHeads(), []);
});

console.log(fail === 0 ? `\n✅ ${pass} passed, ${fail} failed` : `\n❌ ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
