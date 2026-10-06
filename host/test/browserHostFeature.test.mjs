import assert from "node:assert/strict";
import { clampViewport, frameAdmitted } from "../features/browser/stream.js";
import { ANTI_DETECTION_SCRIPT, stripHeadlessUa } from "../features/browser/antiDetection.js";
import { parseCookiesJson, parseNetscapeCookies } from "../features/browser/cookieImport.js";
import { createProfile, listProfiles, removeProfile } from "../features/browser/browserEngine.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("clampViewport caps and defaults", () => {
  assert.deepEqual(clampViewport({ width: 4000, height: 0 }), { width: 1280, height: 1280 });
  assert.deepEqual(clampViewport({ width: 800, height: 1200 }), { width: 800, height: 1200 });
  assert.deepEqual(clampViewport({}), { width: 720, height: 1280 });
});

test("frameAdmitted enforces interval floor", () => {
  assert.equal(frameAdmitted(0, 200), true);
  assert.equal(frameAdmitted(1000, 1050), false);
  assert.equal(frameAdmitted(1000, 1150), true);
});

test("stripHeadlessUa removes Headless token", () => {
  assert.equal(
    stripHeadlessUa("Mozilla/5.0 HeadlessChrome/137.0.0.0 Safari/537.36"),
    "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36"
  );
});

test("anti-detection script parses cleanly", () => {
  assert.match(ANTI_DETECTION_SCRIPT, /navigator, 'webdriver'/);
  new Function(ANTI_DETECTION_SCRIPT);
});

test("cookie parsing: JSON and Netscape formats", () => {
  const jsonRaw = JSON.stringify([
    { name: "sid", value: "123", domain: ".example.com", path: "/", secure: true }
  ]);
  const parsedJson = parseCookiesJson(jsonRaw);
  assert.equal(parsedJson.length, 1);
  assert.equal(parsedJson[0].name, "sid");
  assert.equal(parsedJson[0].domain, ".example.com");

  const netscapeRaw = `.example.com\tTRUE\t/\tTRUE\t1700000000\tsid\txyz\n`;
  const parsedNetscape = parseNetscapeCookies(netscapeRaw);
  assert.equal(parsedNetscape.length, 1);
  assert.equal(parsedNetscape[0].value, "xyz");
});

test("profile management CRUD", async () => {
  const pName = `test_${Date.now()}`;
  createProfile(pName, { userAgentUnmodified: true });
  const list = listProfiles();
  const created = list.find((p) => p.name === pName);
  assert.ok(created);
  assert.equal(created.userAgentUnmodified, true);

  await removeProfile(pName);
  const afterList = listProfiles();
  assert.equal(afterList.some((p) => p.name === pName), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
}
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log(`${tests.length} passed`);
