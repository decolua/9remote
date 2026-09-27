// /download's live release list.
// Run: node --import ./test/loader-alias.mjs test/desktopReleases.test.mjs
//
// `react` is not installed for plain node, so the hook is exercised through the
// plain entry it wraps (loadDesktopReleases) — same approach as rememberedAuth.test.mjs.
// Everything observable is asserted through localStorage, which is where the filter's
// output lands, so no internals need exporting for the test's sake.
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};

const KEY = "9remote_desktop_releases";
const cached = () => JSON.parse(store.get(KEY)).releases;

const { INSTALLERS } = await import("../features/landing/constants/landingConfig.js");
const { loadDesktopReleases } = await import("../features/landing/hooks/useDesktopReleases.js");

const asset = (name) => ({ name });
const fullAssets = INSTALLERS.map((i) => asset(i.asset));
const release = (over = {}) => ({ tag_name: "v1.0.0", published_at: "2026-01-02T03:04:05Z", assets: fullAssets, ...over });

const tick = () => new Promise((r) => setTimeout(r, 0)); // let the promise chain settle
let respond;
let calls = 0;
let lastUrl = null;
globalThis.fetch = (url, ...rest) => { calls++; lastUrl = url; return respond(...rest); };

// ── first load: fetch, filter, cache ───────────────────────────────────────
respond = () => Promise.resolve({ ok: true, json: () => Promise.resolve([release({ tag_name: "v9.9.9" })]) });
loadDesktopReleases();
await tick();
assert.equal(calls, 1, "one fetch");
assert.match(lastUrl, /api\.github\.com\/repos\/decolua\/9remote\/releases/, "reads the public releases API");
assert.deepEqual(cached(), [{ tag: "v9.9.9", date: "2026-01-02" }], "tag + day cached, nothing else");

// ── the filter is what keeps archives and partials out ──────────────────────
const cases = [
  ["draft", release({ draft: true })],
  ["prerelease", release({ prerelease: true })],
  ["asset-less archive tag", release({ assets: [] })],
  ...INSTALLERS.map((i) => [`missing ${i.id}`, release({ assets: fullAssets.filter((a) => a.name !== i.asset) })])
];
for (const [name, rel] of cases) {
  store.clear();
  respond = () => Promise.resolve({ ok: true, json: () => Promise.resolve([rel]) });
  loadDesktopReleases();
  await tick();
  assert.equal(store.has(KEY), false, `${name} must not be cached`);
}

// a mixed list keeps the good release and drops the junk
store.clear();
respond = () => Promise.resolve({ ok: true, json: () => Promise.resolve([release({ assets: [] }), release({ tag_name: "v2.0.0" })]) });
loadDesktopReleases();
await tick();
assert.deepEqual(cached(), [{ tag: "v2.0.0", date: "2026-01-02" }], "junk filtered out of a mixed list");

// ── a fresh cache short-circuits the network ───────────────────────────────
store.set(KEY, JSON.stringify({ releases: [{ tag: "v7.0.0", date: "2026-01-01" }], timestamp: Date.now() }));
respond = () => Promise.reject(new Error("must not be called"));
calls = 0;
loadDesktopReleases();
await tick();
assert.equal(calls, 0, "fresh cache skips the fetch");
assert.equal(cached()[0].tag, "v7.0.0", "and serves the cached version");

// ── an expired cache refetches ─────────────────────────────────────────────
respond = () => Promise.resolve({ ok: true, json: () => Promise.resolve([release({ tag_name: "v8.0.0" })]) });
store.set(KEY, JSON.stringify({ releases: [{ tag: "v7.0.0", date: "2026-01-01" }], timestamp: Date.now() - 2 * 60 * 60 * 1000 }));
calls = 0;
loadDesktopReleases();
await tick();
assert.equal(calls, 1, "cache older than the TTL refetches");
assert.equal(cached()[0].tag, "v8.0.0", "and adopts the newer list");

// ── a failed refresh keeps the last good list (the page goes stale, never blank) ──
respond = () => Promise.reject(new Error("offline"));
store.set(KEY, JSON.stringify({ releases: [{ tag: "v8.0.0", date: "2026-02-02" }], timestamp: 0 }));
calls = 0;
loadDesktopReleases();
await tick();
assert.equal(calls, 1, "an expired cache still tries the network");
assert.equal(cached()[0].tag, "v8.0.0", "failed refresh leaves the cached list untouched");

// ── hostile payloads must not throw ────────────────────────────────────────
for (const bad of ["", "nope", "{}", '{"releases":null}', '{"releases":[]}', "[]"]) {
  respond = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  store.set(KEY, bad);
  calls = 0;
  loadDesktopReleases();
  await tick();
  assert.equal(calls, 1, `unusable cache still tries the network: ${bad || "(empty)"}`);
}

console.log("desktopReleases: all checks passed");
