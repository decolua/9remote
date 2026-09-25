// Remembered login: the localStorage mirror that survives a closed tab.
// Run: node --import ./test/loader-alias.mjs test/rememberedAuth.test.mjs
//
// `react` is not installed for plain node, so the hook is exercised through the
// non-hook entry the hook itself calls (setAuthData) plus a stub window.
import assert from "node:assert/strict";

const store = new Map();
const storage = () => ({
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
});

globalThis.window = {};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.document = { set cookie(v) { this._c = v; }, get cookie() { return this._c || ""; } };

const { setAuthData } = await import("../shared/hooks/useSessionStorage.js");

const STATE_KEY = "9remote_auth_state";
const PREF_KEY = "9remote_remember_key_preference";
const readState = () => JSON.parse(store.get(STATE_KEY) || "null");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const reset = () => { store.clear(); };

test("remember on (default): auth is mirrored to localStorage", () => {
  reset();
  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://x.trycloudflare.com", mode: "remote", localIp: "10.0.0.2" });
  assert.deepEqual(readState(), {
    apiKey: "HEAD1", tunnelUrl: "https://x.trycloudflare.com", mode: "remote", localIp: "10.0.0.2"
  });
});

test("remember off: nothing is mirrored, and an older mirror is dropped", () => {
  reset();
  localStorage.setItem(PREF_KEY, "true");
  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://a", mode: "remote" });
  assert.ok(readState());
  localStorage.setItem(PREF_KEY, "false");
  setAuthData({ apiKey: "HEAD2", tunnelUrl: "https://b", mode: "remote" });
  assert.equal(store.has(STATE_KEY), false, "mirror must not outlive the preference");
});

test("a pairing tempKey is never mirrored — re-pairing is the honest answer", () => {
  reset();
  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://a", mode: "remote", tempKey: "ABC123" });
  assert.equal(readState().tempKey, undefined);
  assert.equal(globalThis.sessionStorage.getItem("tempKey"), "ABC123", "the live session still holds it");
});

test("a session rekeyed away drops the mirror", () => {
  reset();
  localStorage.setItem(PREF_KEY, "true");
  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://a", mode: "remote" });
  setAuthData({ apiKey: "", tunnelUrl: null });
  assert.equal(store.has(STATE_KEY), false);
});

test("storage that throws does not stop the session write", () => {
  reset();
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  globalThis.localStorage = boom;
  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://a", mode: "remote" });
  assert.equal(globalThis.sessionStorage.getItem("apiKey"), "HEAD1");
  globalThis.localStorage = storage();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
