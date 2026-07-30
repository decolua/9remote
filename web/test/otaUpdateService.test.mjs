// Tests for the OTA update service (D1 + KV) — resolve, publish, promote.
// Run: node web/test/otaUpdateService.test.mjs
//
// Uses in-memory fakes for D1/KV: the point is the update-loop invariants,
// not SQL. The bugs these guard against are all silent in production:
//  - promote reusing the same id -> client rejects "already seen" -> stuck
//  - stale KV after publish -> devices keep getting the old bundle
//  - >1 active row per (channel,runtime,platform) -> nondeterministic serve
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeFakeD1, makeFakeKV } from "./helpers/otaFakes.mjs";
import {
  resolveActiveUpdate, publishUpdate, promoteUpdate, cacheKeyFor
} from "../features/ota/lib/updateService.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

const mkEnv = () => ({
  DB: makeFakeD1(),
  OTA_KV: makeFakeKV(),
  R2_PUBLIC_BASE: "https://r2.9remote.cc",
  OTA_SIGNING_PRIVATE_KEY: privateKey,
  OTA_SIGNING_KEY_ID: "main"
});

const ASSETS = [
  { bundleKey: "m1", fileSHA256: "s1", storageKey: "ota/0.1.7/ios/s1", contentType: "application/javascript", fileExtension: ".bundle" },
  { bundleKey: "m2", fileSHA256: "s2", storageKey: "ota/0.1.7/ios/s2", contentType: "image/png", fileExtension: ".png" }
];

const payload = (over = {}) => ({
  runtimeVersion: "0.1.7",
  platform: "ios",
  channel: "production",
  message: "first",
  launchAssetKey: "ota/0.1.7/ios/s1",
  assets: ASSETS,
  expoConfig: { slug: "9remote" },
  publishedBy: "cli",
  ...over
});

console.log("\n[cacheKeyFor]");

await test("key includes channel, runtime and platform", () => {
  assert.equal(cacheKeyFor({ channel: "production", runtimeVersion: "0.1.7", platform: "ios" }), "ota:production:0.1.7:ios");
});

await test("different platforms never collide", () => {
  const a = cacheKeyFor({ channel: "production", runtimeVersion: "0.1.7", platform: "ios" });
  const b = cacheKeyFor({ channel: "production", runtimeVersion: "0.1.7", platform: "android" });
  assert.notEqual(a, b);
});

console.log("\n[publishUpdate]");

await test("rejects a payload missing required fields", async () => {
  const env = mkEnv();
  await assert.rejects(() => publishUpdate(env, payload({ launchAssetKey: undefined })));
  await assert.rejects(() => publishUpdate(env, payload({ runtimeVersion: undefined })));
  await assert.rejects(() => publishUpdate(env, payload({ assets: undefined })));
});

await test("rejects an unknown platform", async () => {
  const env = mkEnv();
  await assert.rejects(() => publishUpdate(env, payload({ platform: "windows" })));
});

await test("creates a row with a uuid id and stores a signature", async () => {
  const env = mkEnv();
  const g = await publishUpdate(env, payload());
  assert.match(g.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.ok(g.signature.startsWith('sig="'), "manifest was not signed");
  assert.ok(g.manifestString.length > 0);
});

await test("buildNumber increments globally across publishes", async () => {
  const env = mkEnv();
  const a = await publishUpdate(env, payload());
  const b = await publishUpdate(env, payload({ message: "second" }));
  assert.equal(a.buildNumber, 1);
  assert.equal(b.buildNumber, 2);
});

await test("archives previous rows so exactly one stays active", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const rows = env.DB._rows("otaUpdateGroup")
    .filter((r) => r.channel === "production" && r.runtimeVersion === "0.1.7" && r.platform === "ios" && r.status === "active");
  assert.equal(rows.length, 1, "more than one active row -> nondeterministic serve");
});

await test("does NOT archive rows of another platform or channel", async () => {
  const env = mkEnv();
  const other = await publishUpdate(env, payload({ platform: "android" }));
  await publishUpdate(env, payload());
  const row = env.DB._rows("otaUpdateGroup").find((r) => r.id === other.id);
  assert.equal(row.status, "active", "cross-platform publish must not archive");
});

await test("points the channel at the new update", async () => {
  const env = mkEnv();
  const g = await publishUpdate(env, payload());
  const p = env.DB._rows("otaChannelPointer")[0];
  assert.equal(p.currentUpdateGroupId, g.id);
});

await test("repointing keeps exactly one pointer row, never zero", async () => {
  // Guards the upsert: a delete+insert pair that dies between the two statements
  // would leave the channel pointerless and every client would see "no update".
  const env = mkEnv();
  await publishUpdate(env, payload());
  const second = await publishUpdate(env, payload({ message: "second" }));
  const rows = env.DB._rows("otaChannelPointer");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currentUpdateGroupId, second.id);
});

await test("keeps a separate pointer per platform", async () => {
  const env = mkEnv();
  const ios = await publishUpdate(env, payload());
  const android = await publishUpdate(env, payload({ platform: "android" }));
  const rows = env.DB._rows("otaChannelPointer");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.platform === "ios").currentUpdateGroupId, ios.id);
  assert.equal(rows.find((r) => r.platform === "android").currentUpdateGroupId, android.id);
});

await test("invalidates the KV cache", async () => {
  const env = mkEnv();
  const key = cacheKeyFor({ channel: "production", runtimeVersion: "0.1.7", platform: "ios" });
  await env.OTA_KV.put(key, JSON.stringify({ stale: true }));
  await publishUpdate(env, payload());
  assert.equal(await env.OTA_KV.get(key), null, "stale cache would keep serving the old bundle");
});

console.log("\n[resolveActiveUpdate]");

const target = { channel: "production", runtimeVersion: "0.1.7", platform: "ios" };

await test("returns null when nothing was ever published", async () => {
  const env = mkEnv();
  assert.equal(await resolveActiveUpdate(env, target), null);
});

await test("returns null for an unknown runtimeVersion", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  assert.equal(await resolveActiveUpdate(env, { ...target, runtimeVersion: "9.9.9" }), null);
});

await test("returns null for an unknown channel", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  assert.equal(await resolveActiveUpdate(env, { ...target, channel: "preview" }), null);
});

await test("returns the published update", async () => {
  const env = mkEnv();
  const g = await publishUpdate(env, payload());
  const got = await resolveActiveUpdate(env, target);
  assert.equal(got.id, g.id);
  assert.ok(got.manifestString.length > 0);
});

await test("returns null when the pointed-at row was archived", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  for (const r of env.DB._rows("otaUpdateGroup")) r.status = "archived";
  await env.OTA_KV.delete(cacheKeyFor(target));
  assert.equal(await resolveActiveUpdate(env, target), null);
});

await test("populates the KV cache on a miss", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  await resolveActiveUpdate(env, target);
  assert.ok(await env.OTA_KV.get(cacheKeyFor(target)), "cache was not warmed");
});

await test("serves from KV without touching D1 on a hit", async () => {
  const env = mkEnv();
  await publishUpdate(env, payload());
  await resolveActiveUpdate(env, target);
  const before = env.DB._queryCount();
  await resolveActiveUpdate(env, target);
  assert.equal(env.DB._queryCount(), before, "cache hit still queried D1");
});

await test("cached payload keeps the exact signed manifestString", async () => {
  const env = mkEnv();
  const g = await publishUpdate(env, payload());
  await resolveActiveUpdate(env, target);
  const cached = await resolveActiveUpdate(env, target);
  assert.equal(cached.manifestString, g.manifestString, "cache mutated the signed bytes");
  assert.equal(cached.signature, g.signature);
});

console.log("\n[promoteUpdate]");

await test("throws for an unknown id", async () => {
  const env = mkEnv();
  await assert.rejects(() => promoteUpdate(env, "nope"));
});

await test("creates a NEW id — never reuses the source id", async () => {
  // Clients reject a manifest id they have already seen; reusing it makes
  // rollback a silent no-op and can loop the updater.
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  assert.notEqual(promoted.id, first.id);
});

await test("reuses the source assets and launchAssetKey", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  assert.equal(promoted.launchAssetKey, first.launchAssetKey);
  assert.deepEqual(promoted.assets, ASSETS);
});

await test("assigns a fresh buildNumber above every existing one", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  const second = await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  assert.ok(promoted.buildNumber > second.buildNumber);
});

await test("re-signs so the new id is inside the signed manifest", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  assert.equal(JSON.parse(promoted.manifestString).id, promoted.id);
  assert.notEqual(promoted.signature, first.signature);
});

await test("moves the channel pointer to the new row", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  const p = env.DB._rows("otaChannelPointer")[0];
  assert.equal(p.currentUpdateGroupId, promoted.id);
});

await test("leaves exactly one active row after promoting", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  await promoteUpdate(env, first.id);
  const active = env.DB._rows("otaUpdateGroup").filter((r) => r.status === "active");
  assert.equal(active.length, 1);
});

await test("invalidates the KV cache", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  await resolveActiveUpdate(env, target);
  await promoteUpdate(env, first.id);
  assert.equal(await env.OTA_KV.get(cacheKeyFor(target)), null);
});

await test("resolve returns the promoted row afterwards", async () => {
  const env = mkEnv();
  const first = await publishUpdate(env, payload());
  await publishUpdate(env, payload({ message: "second" }));
  const promoted = await promoteUpdate(env, first.id);
  const got = await resolveActiveUpdate(env, target);
  assert.equal(got.id, promoted.id);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
