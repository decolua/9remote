// Local sites must not run on the app's own origin — that origin holds the
// device-trust tail and the saved keys, so a script in a browsed dev server
// would be reading credentials that lead to a terminal on the host.
//
// Two halves are covered here: the routing rules that decide what the sites
// host is allowed to serve, and the postMessage relay that replaces the
// same-origin serviceWorker handle the bridge used to hold.
// Run: node --import ./test/loader-alias.mjs web/test/sitesOrigin.test.mjs
import assert from "node:assert/strict";
import { isSitesHost, routeSitesRequest, SITES_ALLOWED_PATHS } from "../shared/utils/sitesHost.js";
import { SITES_ORIGIN, siteProxySrc, isSitesOrigin } from "../features/browser/constants/browserConfig.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Host detection ──────────────────────────────────────────────────────────

console.log("Suite 1: which hostnames are the sites host");

test("the production sites subdomain is recognised", () => {
  assert.equal(isSitesHost("sites.9remote.cc"), true);
});

test("the dev sites subdomain is recognised", () => {
  assert.equal(isSitesHost("sites-dev.9remote.cc"), true);
});

test("the app host is not the sites host", () => {
  assert.equal(isSitesHost("9remote.cc"), false);
  assert.equal(isSitesHost("dev.9remote.cc"), false);
});

test("a lookalike host outside the zone is rejected", () => {
  // Substring matching would accept these; the check must be exact.
  assert.equal(isSitesHost("sites.9remote.cc.evil.tld"), false);
  assert.equal(isSitesHost("evil-sites.9remote.cc"), false);
  assert.equal(isSitesHost("notsites.9remote.cc"), false);
});

test("localhost dev is recognised so the feature works before deploy", () => {
  assert.equal(isSitesHost("sites.localhost"), true);
});

// ── What the sites host may serve ───────────────────────────────────────────

console.log("Suite 2: the sites host serves three things and nothing else");

const served = (pathname) => routeSitesRequest(pathname)?.kind || null;

test("the proxy page is served", () => {
  assert.equal(served("/proxy.html"), "asset");
});

test("the service worker is served", () => {
  assert.equal(served("/sw-site.js"), "asset");
});

test("root serves the proxy page", () => {
  assert.equal(served("/"), "asset");
});

test("browse paths are handed to the service worker", () => {
  assert.equal(served("/browse/3000/"), "browse");
  assert.equal(served("/browse/5173/assets/app.js"), "browse");
});

test("the app's API is NOT reachable on this host", () => {
  // The whole point: this origin must not be able to speak to the session API,
  // or a script here could mint and read what it was isolated away from.
  assert.equal(served("/api/session/create"), null);
  assert.equal(served("/api/connect"), null);
  assert.equal(served("/api/admin/login"), null);
});

test("the app's pages are NOT reachable on this host", () => {
  assert.equal(served("/workspace"), null);
  assert.equal(served("/login"), null);
});

test("signaling is NOT reachable on this host", () => {
  assert.equal(served("/signaling/ws/sk-abcd1234-qrstuvwx"), null);
});

test("traversal cannot reach a disallowed path", () => {
  assert.equal(served("/browse/../api/connect"), null);
  assert.equal(served("/proxy.html/../../api/connect"), null);
});

test("the allowed-path list stays small and explicit", () => {
  // A regression here means someone widened the surface; make it loud.
  assert.deepEqual([...SITES_ALLOWED_PATHS].sort(), ["/", "/proxy.html", "/sw-site.js"]);
});

// ── Response headers ────────────────────────────────────────────────────────

console.log("Suite 3: headers on what the sites host returns");

test("every sites response asks for its own agent cluster", () => {
  // Chrome remembers the answer from the first response for the origin, so it
  // has to be on all of them, not just the document.
  for (const p of ["/", "/proxy.html", "/sw-site.js", "/browse/3000/"]) {
    const headers = routeSitesRequest(p)?.headers || {};
    assert.equal(headers["Origin-Agent-Cluster"], "?1", `missing on ${p}`);
  }
});

test("the service worker is allowed to claim the whole origin", () => {
  const headers = routeSitesRequest("/sw-site.js")?.headers || {};
  assert.equal(headers["Service-Worker-Allowed"], "/");
});

// ── The origin the app points its iframe at ─────────────────────────────────

console.log("Suite 4: the app targets the sites origin, never its own");

test("the proxy src is absolute and on the sites origin", () => {
  const src = siteProxySrc(3000, "/dashboard");
  assert.ok(src.startsWith(SITES_ORIGIN + "/proxy.html"), `got ${src}`);
});

test("port and path ride in the fragment, not the query", () => {
  // A fragment is never sent to the server, which keeps the browsed address
  // out of request logs at the edge.
  const src = siteProxySrc(3000, "/a/b?c=d");
  const [beforeHash, afterHash] = src.split("#");
  assert.ok(!beforeHash.includes("3000"), "port leaked into the request URL");
  assert.ok(afterHash.includes("3000"));
  assert.ok(afterHash.includes(encodeURIComponent("/a/b?c=d")));
});

test("a path with a quote cannot break out of the attribute", () => {
  const src = siteProxySrc(3000, '/x"><script>alert(1)</script>');
  assert.ok(!src.includes('"'), `unescaped quote in ${src}`);
  assert.ok(!src.includes("<"), `unescaped angle bracket in ${src}`);
});

test("a non-numeric port is refused rather than interpolated", () => {
  assert.equal(siteProxySrc("3000; DROP", "/"), null);
  assert.equal(siteProxySrc(null, "/"), null);
  assert.equal(siteProxySrc(70000, "/"), null);
});

test("the app origin is not mistaken for the sites origin", () => {
  assert.equal(isSitesOrigin("https://9remote.cc"), false);
  assert.equal(isSitesOrigin(SITES_ORIGIN), true);
});

test("a null origin (sandboxed frame) is not trusted", () => {
  // postMessage from an opaque origin arrives as the string "null".
  assert.equal(isSitesOrigin("null"), false);
  assert.equal(isSitesOrigin(""), false);
  assert.equal(isSitesOrigin(undefined), false);
});

// ── Who may frame the proxy shell ───────────────────────────────────────────

console.log("Suite 5: the proxy shell refuses to be framed by strangers");

test("only the app origin may frame anything on the sites host", () => {
  // The shell relays requests that end at the user's localhost, so a page that
  // could frame it would be reaching into their machine. JS checks the sender,
  // but the header is what holds when the JS check is the thing that regressed.
  for (const p of ["/", "/proxy.html", "/browse/3000/"]) {
    const csp = routeSitesRequest(p)?.headers?.["Content-Security-Policy"] || "";
    assert.match(csp, /frame-ancestors https:\/\/9remote\.cc/, `missing on ${p}`);
  }
});

test("frame-ancestors does not fall back to a wildcard", () => {
  const csp = routeSitesRequest("/proxy.html")?.headers?.["Content-Security-Policy"] || "";
  assert.ok(!/frame-ancestors[^;]*\*/.test(csp), `wildcard in ${csp}`);
});

test("the sites host sets no CORS header of its own", () => {
  // An allow-origin here would hand a browsed site a way to read the app's
  // responses through this origin.
  for (const p of ["/", "/proxy.html", "/sw-site.js", "/browse/3000/"]) {
    const headers = routeSitesRequest(p)?.headers || {};
    assert.equal(headers["Access-Control-Allow-Origin"], undefined, `set on ${p}`);
  }
});

test("each sites host names its own app origin, not a shared one", () => {
  const prod = routeSitesRequest("/proxy.html", "sites.9remote.cc").headers["Content-Security-Policy"];
  const dev = routeSitesRequest("/proxy.html", "sites-dev.9remote.cc").headers["Content-Security-Policy"];
  assert.match(prod, /https:\/\/9remote\.cc$/);
  assert.match(dev, /https:\/\/dev\.9remote\.cc$/);
  assert.notEqual(prod, dev);
});

test("an unrecognised host may be framed by nobody", () => {
  // Fail closed: a host we do not know is not given the benefit of the doubt.
  const csp = routeSitesRequest("/proxy.html", "sites.evil.tld").headers["Content-Security-Policy"];
  assert.equal(csp, "frame-ancestors 'none'");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
