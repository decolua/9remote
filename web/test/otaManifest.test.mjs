// Tests for the OTA manifest layer (Expo Updates protocol v1).
// Run: node web/test/otaManifest.test.mjs
//
// Covers the parts that fail SILENTLY in production if wrong:
//  - signature must be over the EXACT bytes served (manifestString)
//  - asset url must NOT carry the file extension (client appends fileExtension)
//  - launchAsset must be excluded from assets[] and omit fileExtension
//  - multipart framing must be CRLF + expo-signature on the manifest part only
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildAssetUrl, buildManifest, buildSignedManifest, signBody, buildMultipart
} from "../features/ota/lib/manifest.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// PKCS#8 RSA key — WebCrypto only accepts pkcs8, never pkcs1
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

const BASE = "https://r2.9remote.cc";
const KEY_ID = "main";

const LAUNCH = {
  bundleKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fileSHA256: "hashLaunch_-",
  storageKey: "ota/0.1.7/ios/hashLaunch_-",
  contentType: "application/javascript",
  fileExtension: ".bundle"
};
const IMAGE = {
  bundleKey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  fileSHA256: "hashImage_-",
  storageKey: "ota/0.1.7/ios/hashImage_-",
  contentType: "image/png",
  fileExtension: ".png"
};

const GROUP = {
  id: "11111111-2222-3333-4444-555555555555",
  runtimeVersion: "0.1.7",
  platform: "ios",
  channel: "production",
  createdAt: "2026-07-30T00:00:00.000Z",
  launchAssetKey: LAUNCH.storageKey,
  assets: [LAUNCH, IMAGE],
  expoConfig: { name: "9Remote", slug: "9remote", extra: { eas: { projectId: "abc" } } }
};

console.log("\n[buildAssetUrl]");

await test("joins base + key without double slash", () => {
  assert.equal(buildAssetUrl("ota/a/b", BASE), "https://r2.9remote.cc/ota/a/b");
});

await test("tolerates trailing slash on base and leading slash on key", () => {
  assert.equal(buildAssetUrl("/ota/a", "https://r2.9remote.cc/"), "https://r2.9remote.cc/ota/a");
});

await test("does NOT append the file extension to the url", () => {
  // Client appends manifest.fileExtension itself; a duplicated ext breaks the
  // local write path -> AssetsFailedToLoad -> endless update loop.
  const url = buildAssetUrl(IMAGE.storageKey, BASE);
  assert.ok(!url.endsWith(".png"), `url must not end with .png, got ${url}`);
});

console.log("\n[buildManifest]");

await test("returns the protocol-required top-level fields", () => {
  const m = buildManifest(GROUP, BASE);
  for (const k of ["id", "createdAt", "runtimeVersion", "launchAsset", "assets", "metadata", "extra"]) {
    assert.ok(k in m, `missing field ${k}`);
  }
  assert.equal(m.id, GROUP.id);
  assert.equal(m.runtimeVersion, "0.1.7");
});

await test("createdAt is ISO-8601", () => {
  const m = buildManifest(GROUP, BASE);
  assert.equal(m.createdAt, new Date(GROUP.createdAt).toISOString());
});

await test("launchAsset omits fileExtension", () => {
  const m = buildManifest(GROUP, BASE);
  assert.ok(!("fileExtension" in m.launchAsset), "launchAsset must not carry fileExtension");
});

await test("launchAsset is excluded from assets[]", () => {
  const m = buildManifest(GROUP, BASE);
  assert.equal(m.assets.length, 1);
  assert.equal(m.assets[0].key, IMAGE.bundleKey);
});

await test("asset key=md5 (bundleKey) and hash=sha256 — not swapped", () => {
  const m = buildManifest(GROUP, BASE);
  assert.equal(m.assets[0].key, IMAGE.bundleKey);
  assert.equal(m.assets[0].hash, IMAGE.fileSHA256);
  assert.equal(m.launchAsset.key, LAUNCH.bundleKey);
  assert.equal(m.launchAsset.hash, LAUNCH.fileSHA256);
});

await test("non-launch asset keeps its fileExtension", () => {
  const m = buildManifest(GROUP, BASE);
  assert.equal(m.assets[0].fileExtension, ".png");
});

await test("extra carries expoClient and hoists eas", () => {
  const m = buildManifest(GROUP, BASE);
  assert.equal(m.extra.expoClient.slug, "9remote");
  assert.deepEqual(m.extra.eas, { projectId: "abc" });
});

await test("omits eas when expoConfig has none", () => {
  const m = buildManifest({ ...GROUP, expoConfig: { slug: "x" } }, BASE);
  assert.ok(!("eas" in m.extra), "eas must be absent, not undefined-valued");
});

console.log("\n[signBody]");

await test("returns null when no private key configured", async () => {
  assert.equal(await signBody("{}", "", KEY_ID), null);
});

await test("emits an SFV dictionary with sig, keyid, alg", async () => {
  const sig = await signBody('{"a":1}', privateKey, KEY_ID);
  assert.match(sig, /^sig="[A-Za-z0-9+/=]+", keyid="main", alg="rsa-v1_5-sha256"$/);
});

await test("signature verifies against the public key (RSA-SHA256)", async () => {
  const body = '{"hello":"world"}';
  const sig = await signBody(body, privateKey, KEY_ID);
  const b64 = sig.match(/sig="([^"]+)"/)[1];
  const ok = crypto.verify("RSA-SHA256", Buffer.from(body, "utf8"), publicKey, Buffer.from(b64, "base64"));
  assert.ok(ok, "signature did not verify — client would reject the update");
});

await test("accepts a PEM with escaped \\n (env-var round-trip)", async () => {
  const escaped = privateKey.replace(/\n/g, "\\n");
  const sig = await signBody("{}", escaped, KEY_ID);
  assert.ok(sig && sig.startsWith('sig="'), "must normalize escaped newlines from env");
});

await test("accepts a PEM with CRLF line endings", async () => {
  const crlf = privateKey.replace(/\n/g, "\r\n");
  const sig = await signBody("{}", crlf, KEY_ID);
  assert.ok(sig && sig.startsWith('sig="'), "must tolerate CRLF");
});

await test("different bodies produce different signatures", async () => {
  const a = await signBody('{"a":1}', privateKey, KEY_ID);
  const b = await signBody('{"a":2}', privateKey, KEY_ID);
  assert.notEqual(a, b);
});

console.log("\n[buildSignedManifest]");

await test("signature covers the EXACT manifestString that will be served", async () => {
  // The #1 silent failure: serving a re-stringified object whose bytes differ
  // from what was signed. Verify against manifestString, not JSON.stringify(json).
  const { manifestString, signature } = await buildSignedManifest(GROUP, BASE, privateKey, KEY_ID);
  const b64 = signature.match(/sig="([^"]+)"/)[1];
  const ok = crypto.verify("RSA-SHA256", Buffer.from(manifestString, "utf8"), publicKey, Buffer.from(b64, "base64"));
  assert.ok(ok, "signature does not match manifestString bytes");
});

await test("manifestString parses back to manifestJson", async () => {
  const { manifestJson, manifestString } = await buildSignedManifest(GROUP, BASE, privateKey, KEY_ID);
  assert.deepEqual(JSON.parse(manifestString), manifestJson);
});

await test("returns empty signature when signing is disabled", async () => {
  const { signature } = await buildSignedManifest(GROUP, BASE, "", KEY_ID);
  assert.equal(signature, "");
});

console.log("\n[buildMultipart]");

const PARTS = [
  { name: "manifest", contentType: "application/json", body: '{"id":"x"}', signature: 'sig="s", keyid="main", alg="rsa-v1_5-sha256"' },
  { name: "extensions", contentType: "application/json", body: '{"assetRequestHeaders":{}}' }
];

await test("boundary is returned and present in the body", () => {
  const { boundary, body } = buildMultipart(PARTS);
  assert.ok(boundary.length > 8);
  assert.ok(body.includes(`--${boundary}\r\n`));
});

await test("each boundary generation is unique", () => {
  const a = buildMultipart(PARTS).boundary;
  const b = buildMultipart(PARTS).boundary;
  assert.notEqual(a, b);
});

await test("uses CRLF line endings, never bare LF", () => {
  const { body } = buildMultipart(PARTS);
  assert.ok(!/[^\r]\n/.test(body), "found a bare LF — breaks multipart parsing");
});

await test("emits content-disposition with the part name", () => {
  const { body } = buildMultipart(PARTS);
  assert.ok(body.includes('content-disposition: form-data; name="manifest"'));
  assert.ok(body.includes('content-disposition: form-data; name="extensions"'));
});

await test("expo-signature only on the part that has one", () => {
  const { body } = buildMultipart(PARTS);
  assert.equal((body.match(/expo-signature:/g) || []).length, 1);
});

await test("omits expo-signature entirely when signature is empty", () => {
  const { body } = buildMultipart([{ name: "manifest", contentType: "application/json", body: "{}", signature: "" }]);
  assert.ok(!body.includes("expo-signature"));
});

await test("terminates with the closing boundary", () => {
  const { boundary, body } = buildMultipart(PARTS);
  assert.ok(body.endsWith(`--${boundary}--\r\n`));
});

await test("part body is preserved byte-for-byte", () => {
  const { body } = buildMultipart(PARTS);
  assert.ok(body.includes('{"id":"x"}'), "manifest body altered");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
