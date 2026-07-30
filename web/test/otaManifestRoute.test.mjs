// Tests for the public OTA manifest endpoint (Expo Updates protocol v1).
// Run: node web/test/otaManifestRoute.test.mjs
//
// The client is unforgiving here: a wrong status code or a missing header
// turns into "no updates ever" or an endless re-download loop, with no error
// surfaced in the app.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeFakeD1, makeFakeKV } from "./helpers/otaFakes.mjs";
import { handleManifestRequest } from "../features/ota/lib/manifestRoute.js";
import { publishUpdate } from "../features/ota/lib/updateService.js";

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
  OTA_SIGNING_KEY_ID: "main",
  OTA_DEFAULT_CHANNEL: "production"
});

const ASSETS = [
  { bundleKey: "m1", fileSHA256: "s1", storageKey: "ota/0.1.7/ios/s1", contentType: "application/javascript", fileExtension: ".bundle" },
  { bundleKey: "m2", fileSHA256: "s2", storageKey: "ota/0.1.7/ios/s2", contentType: "image/png", fileExtension: ".png" }
];

const seed = (env, over = {}) => publishUpdate(env, {
  runtimeVersion: "0.1.7",
  platform: "ios",
  channel: "production",
  message: "test",
  launchAssetKey: "ota/0.1.7/ios/s1",
  assets: ASSETS,
  expoConfig: { slug: "9remote" },
  publishedBy: "test",
  ...over
});

// Build a Request carrying the headers expo-updates actually sends
const mkRequest = (over = {}) => {
  const h = new Headers({
    "expo-platform": "ios",
    "expo-runtime-version": "0.1.7",
    "expo-channel-name": "production",
    "expo-protocol-version": "1",
    ...over
  });
  for (const [k, v] of Object.entries(over)) if (v === null) h.delete(k);
  return new Request("https://9remote.cc/api/ota/manifest", { method: "GET", headers: h });
};

console.log("\n[request validation]");

await test("400 when expo-platform is missing", async () => {
  const res = await handleManifestRequest(mkEnv(), mkRequest({ "expo-platform": null }));
  assert.equal(res.status, 400);
});

await test("400 for an unsupported platform", async () => {
  const res = await handleManifestRequest(mkEnv(), mkRequest({ "expo-platform": "windows" }));
  assert.equal(res.status, 400);
});

await test("400 when expo-runtime-version is missing", async () => {
  const res = await handleManifestRequest(mkEnv(), mkRequest({ "expo-runtime-version": null }));
  assert.equal(res.status, 400);
});

await test("falls back to the default channel when the header is absent", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest({ "expo-channel-name": null }));
  assert.equal(res.status, 200);
});

console.log("\n[204 no-update paths]");

await test("204 when nothing is published for that runtime", async () => {
  const res = await handleManifestRequest(mkEnv(), mkRequest());
  assert.equal(res.status, 204);
});

await test("204 when the client already has the latest update", async () => {
  const env = mkEnv();
  const g = await seed(env);
  const res = await handleManifestRequest(env, mkRequest({ "expo-current-update-id": g.id }));
  assert.equal(res.status, 204, "re-serving the same id makes the client loop");
});

await test("200 when the client holds a different (older) update id", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest({ "expo-current-update-id": "00000000-0000-0000-0000-000000000000" }));
  assert.equal(res.status, 200);
});

await test("204 for a platform with no build, even if the other platform has one", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest({ "expo-platform": "android" }));
  assert.equal(res.status, 204);
});

console.log("\n[response headers]");

await test("always sets expo-protocol-version and expo-sfv-version", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest());
  assert.equal(res.headers.get("expo-protocol-version"), "1");
  assert.equal(res.headers.get("expo-sfv-version"), "0");
});

await test("sets protocol headers on the 204 path too", async () => {
  const res = await handleManifestRequest(mkEnv(), mkRequest());
  assert.equal(res.headers.get("expo-protocol-version"), "1");
});

await test("is explicitly uncacheable", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest());
  assert.match(res.headers.get("cache-control"), /no-store/);
});

await test("content-type is multipart/mixed with a boundary", async () => {
  const env = mkEnv();
  await seed(env);
  const ct = (await handleManifestRequest(env, mkRequest())).headers.get("content-type");
  assert.match(ct, /^multipart\/mixed; boundary=/);
});

console.log("\n[response body]");

await test("boundary in the header matches the body", async () => {
  const env = mkEnv();
  await seed(env);
  const res = await handleManifestRequest(env, mkRequest());
  const boundary = res.headers.get("content-type").split("boundary=")[1];
  assert.ok((await res.text()).includes(`--${boundary}`));
});

await test("carries both the manifest and extensions parts", async () => {
  const env = mkEnv();
  await seed(env);
  const body = await (await handleManifestRequest(env, mkRequest())).text();
  assert.ok(body.includes('name="manifest"'));
  assert.ok(body.includes('name="extensions"'));
});

await test("manifest part carries the expo-signature", async () => {
  const env = mkEnv();
  await seed(env);
  const body = await (await handleManifestRequest(env, mkRequest())).text();
  assert.match(body, /expo-signature: sig="[^"]+", keyid="main", alg="rsa-v1_5-sha256"/);
});

await test("serves the exact stored manifestString, byte for byte", async () => {
  const env = mkEnv();
  const g = await seed(env);
  const body = await (await handleManifestRequest(env, mkRequest())).text();
  assert.ok(body.includes(g.manifestString), "re-serialized manifest breaks the signature");
});

await test("extensions lists assetRequestHeaders for every asset key", async () => {
  const env = mkEnv();
  await seed(env);
  const body = await (await handleManifestRequest(env, mkRequest())).text();
  // Extract the extensions part body (between headers and the closing boundary)
  const marker = 'name="extensions"';
  const startIdx = body.indexOf(marker);
  const bodyStart = body.indexOf("\r\n\r\n", startIdx) + 4;
  const bodyEnd = body.indexOf("\r\n--", bodyStart);
  const ext = JSON.parse(body.slice(bodyStart, bodyEnd));
  const keys = Object.keys(ext.assetRequestHeaders).sort();
  assert.deepEqual(keys, ["m1", "m2"], "a missing key makes that asset fail to download");
});

await test("asset urls point at the R2 public base", async () => {
  const env = mkEnv();
  await seed(env);
  const body = await (await handleManifestRequest(env, mkRequest())).text();
  assert.ok(body.includes("https://r2.9remote.cc/ota/0.1.7/ios/s1"));
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
