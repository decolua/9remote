import assert from "node:assert/strict";
import { clampViewport, cdpTouchPoints, frameAdmitted } from "../features/browser/stream.js";
import { ANTI_DETECTION_SCRIPT, stripHeadlessUa } from "../features/browser/antiDetection.js";
import { parseCookiesJson, parseNetscapeCookies } from "../features/browser/cookieImport.js";
import { createProfile, listProfiles, normalizeUrlInput, removeProfile, scoreHistory } from "../features/browser/browserEngine.js";
import { isPublicAddress, normalizeSiteHost, startProxySession, endProxySession } from "../proxy/index.js";
import { clearSiteCookies, cookieHeaderFor, parseSetCookie, storeSetCookies } from "../proxy/index.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("clampViewport caps and defaults", () => {
  assert.deepEqual(clampViewport({ width: 4000, height: 0 }), { width: 1920, height: 1280, scale: 1 });
  assert.deepEqual(clampViewport({ width: 800, height: 1200 }), { width: 800, height: 1200, scale: 1 });
  assert.deepEqual(clampViewport({}), { width: 720, height: 1280, scale: 1 });
  // Retina scale rides along, capped at 2
  assert.deepEqual(clampViewport({ width: 500, height: 400, scale: 3 }), { width: 500, height: 400, scale: 2 });
});

test("frameAdmitted enforces interval floor", () => {
  assert.equal(frameAdmitted(0, 200), true);
  assert.equal(frameAdmitted(1000, 1020), false); // 20ms < 33ms floor
  assert.equal(frameAdmitted(1000, 1040), true); // 40ms ≥ 33ms floor
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
  createProfile(pName);
  const list = listProfiles();
  const created = list.find((p) => p.name === pName);
  assert.ok(created);

  await removeProfile(pName);
  const afterList = listProfiles();
  assert.equal(afterList.some((p) => p.name === pName), false);
});

test("scoreHistory ranks prefix > host > substring > title", () => {
  const list = [
    { url: "https://docs.example.com/guide", ts: 1 },
    { url: "https://example.com/guide", ts: 2 },
    { url: "https://other.org/page", title: "Guide page", ts: 3 },
    { url: "https://zzz.io/ex", ts: 4 }
  ];
  const ranked = scoreHistory(list, "example");
  assert.equal(ranked[0].url, "https://example.com/guide"); // host match beats substring
  assert.equal(ranked[1].url, "https://docs.example.com/guide");
  const byTitle = scoreHistory(list, "guide page");
  assert.equal(byTitle[0].url, "https://other.org/page");
  assert.equal(scoreHistory(list, "nomatch").length, 0);
  // Empty query: recent first, capped at 8
  assert.equal(scoreHistory(list, "")[0].url, "https://zzz.io/ex");
});

test("normalizeUrlInput: scheme, https-prefix, search fallback", () => {
  assert.equal(normalizeUrlInput(""), "about:blank");
  assert.equal(normalizeUrlInput("about:blank"), "about:blank");
  assert.equal(normalizeUrlInput("http://x.test/a"), "http://x.test/a");
  assert.equal(normalizeUrlInput("example.com"), "https://example.com");
  assert.equal(normalizeUrlInput("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeUrlInput("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrlInput("127.0.0.1"), "http://127.0.0.1");
  assert.equal(
    normalizeUrlInput("how to center a div"),
    "https://www.google.com/search?q=" + encodeURIComponent("how to center a div")
  );
});

test("cdpTouchPoints normalizes and caps the touch batch", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ x: i * 10, y: i * 20 }));
  const pts = cdpTouchPoints(many);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[1], { x: 10, y: 20 });
  assert.deepEqual(cdpTouchPoints(null), []);
  assert.deepEqual(cdpTouchPoints([{ x: "12", y: "bad" }]), [{ x: 12, y: 0 }]);
});

test("isPublicAddress blocks every private/reserved range (SSRF guard)", () => {
  const blocked = [
    "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "127.0.0.1",
    "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    "not-an-ip"
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
  const allowed = ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2001:db8::1"];
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, ip);
});

test("normalizeSiteHost accepts hostnames, refuses IPs and junk", () => {
  assert.equal(normalizeSiteHost("VNExpress.NET."), "vnexpress.net");
  assert.equal(normalizeSiteHost("www.example.co.uk"), "www.example.co.uk");
  assert.equal(normalizeSiteHost("192.168.1.1"), null);
  assert.equal(normalizeSiteHost("localhost"), null); // dotless — not a public site
  assert.equal(normalizeSiteHost("a b.com"), null);
  assert.equal(normalizeSiteHost(""), null);
  assert.equal(normalizeSiteHost("-bad.com"), null);
});

test("proxy sessions: port ids vs host sessions", () => {
  const id = startProxySession(3999);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(startProxySession(3999), id); // idempotent per port
  assert.equal(startProxySession("vnexpress.net"), "site:vnexpress.net");
  assert.equal(startProxySession("192.168.0.1"), null);
  assert.equal(startProxySession("bad host"), null);
  endProxySession(3999);
  endProxySession("vnexpress.net");
});

test("cookie jar: parse, store, replay per domain", () => {
  const c = parseSetCookie("sid=abc; Path=/; Max-Age=3600; Domain=.example.com; HttpOnly; Secure");
  assert.equal(c.name, "sid");
  assert.equal(c.value, "abc");
  assert.equal(c.domain, "example.com");
  assert.equal(c.maxAge, 3600);

  storeSetCookies("www.example.com", [
    "sid=abc; Domain=.example.com; Path=/",
    "theme=dark; Path=/"
  ]);
  // Domain cookie serves every subdomain; host cookie only its own host.
  assert.equal(cookieHeaderFor("www.example.com"), "sid=abc; theme=dark");
  assert.equal(cookieHeaderFor("api.example.com"), "sid=abc");
  assert.equal(cookieHeaderFor("other.org"), null);

  // Empty value and past expiry delete; session cookies (no expiry) stay.
  storeSetCookies("www.example.com", ["sid=; Path=/", `theme=dark; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]);
  assert.equal(cookieHeaderFor("www.example.com"), null);

  storeSetCookies("a.test", ["keep=1; Path=/"]);
  clearSiteCookies("a.test");
  assert.equal(cookieHeaderFor("a.test"), null);

  // A Domain attribute that does not cover the setting host is ignored.
  storeSetCookies("evil.io", ["x=1; Domain=.example.com"]);
  assert.equal(cookieHeaderFor("api.example.com"), null);
  assert.equal(cookieHeaderFor("evil.io"), "x=1");
  clearSiteCookies("evil.io");

  // Port jars (localhost sites): exact key only, Domain attribute never matches.
  storeSetCookies(":20128", ["auth_token=tok; Path=/; HttpOnly"]);
  assert.equal(cookieHeaderFor(":20128"), "auth_token=tok");
  assert.equal(cookieHeaderFor(":20129"), null);
  assert.equal(cookieHeaderFor("example.com"), null);
  clearSiteCookies(":20128");
  assert.equal(cookieHeaderFor(":20128"), null);
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
