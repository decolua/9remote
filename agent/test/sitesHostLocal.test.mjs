// The sites host on the agent's own server (the embedded workspace at
// localhost:2208) — same boundary as the hosted deploy, one port away from the
// local API instead of one subdomain away.
//
// Run: node --test agent/test/sitesHostLocal.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSitesHost, routeSitesLocalRequest, appOriginFor, SITES_ALLOWED_PATHS } from "../lib/sitesHost.js";

const served = (pathname, hostname = "sites.localhost:2208") =>
  routeSitesLocalRequest(pathname, hostname)?.kind || null;

test("only loopback names are the sites host", () => {
  assert.equal(isSitesHost("sites.localhost"), true);
  assert.equal(isSitesHost("sites.localhost:2208"), true);
  assert.equal(isSitesHost("sites.127.0.0.1:2208"), true);
  // The app's own names, and anything that merely resembles the sites host.
  assert.equal(isSitesHost("localhost:2208"), false);
  assert.equal(isSitesHost("127.0.0.1:2208"), false);
  assert.equal(isSitesHost("sites.localhost.evil.tld"), false);
  assert.equal(isSitesHost("notsites.localhost"), false);
  assert.equal(isSitesHost(undefined), false);
});

test("the three site files are served, and the browse scope is handed to the worker", () => {
  assert.equal(served("/proxy.html"), "asset");
  assert.equal(served("/sw-site.js"), "asset");
  assert.equal(served("/swBridgeClaim.js"), "asset");
  assert.equal(served("/browse/3000/"), "browse");
  assert.equal(served("/browse/5173/assets/app.js"), "browse");
  // Browse paths load the shell, which then registers the worker and retries.
  assert.equal(routeSitesLocalRequest("/browse/3000/", "sites.localhost").path, "/proxy.html");
});

test("the local API is NOT reachable on this host", () => {
  // This is the whole point of the second origin: a script inside a browsed dev
  // server must not be able to read the key that leads to a shell.
  for (const p of ["/api/ui/state", "/api/key/one-time", "/api/local-token", "/api/connections", "/api/device/approved", "/socket.io/"]) {
    assert.equal(served(p), null, `served ${p}`);
  }
});

test("the app's own pages are NOT reachable on this host", () => {
  for (const p of ["/", "//", "/workspace", "/login", "/ui/index.html"]) {
    if (p === "/") { assert.equal(served(p), "asset"); continue; }
    assert.equal(served(p), null, `served ${p}`);
  }
});

test("traversal cannot reach a disallowed path", () => {
  for (const p of ["/browse/../api/ui/state", "/proxy.html/../../api/ui/state", "/browse/%2e%2e/api/ui/state"]) {
    const route = routeSitesLocalRequest(p, "sites.localhost");
    assert.notEqual(route?.path, "/api/ui/state", `escaped with ${p}`);
    assert.ok(route === null || route.kind === "browse", `unexpected route for ${p}`);
  }
});

test("the allowed-path list stays small and explicit", () => {
  assert.deepEqual([...SITES_ALLOWED_PATHS].sort(), ["/", "/proxy.html", "/sw-site.js", "/swBridgeClaim.js"]);
});

test("the worker is allowed to claim the whole origin", () => {
  assert.equal(routeSitesLocalRequest("/sw-site.js", "sites.localhost:2208").headers["Service-Worker-Allowed"], "/");
  // Only the worker: nothing else here registers a scope.
  assert.equal(routeSitesLocalRequest("/proxy.html", "sites.localhost:2208").headers["Service-Worker-Allowed"], undefined);
});

test("every site response asks for its own agent cluster", () => {
  for (const p of ["/", "/proxy.html", "/sw-site.js", "/browse/3000/"]) {
    assert.equal(routeSitesLocalRequest(p, "sites.localhost:2208").headers["Origin-Agent-Cluster"], "?1", `missing on ${p}`);
  }
});

test("a site is framable by the app above it, and by no wildcard", () => {
  for (const p of ["/", "/proxy.html", "/browse/3000/"]) {
    const csp = routeSitesLocalRequest(p, "sites.localhost:2208").headers["Content-Security-Policy"];
    assert.equal(csp, "frame-ancestors 'self' http://localhost:2208", `wrong on ${p}`);
    assert.ok(!csp.includes("*"), `wildcard on ${p}`);
  }
});

test("the app origin keeps the port it was asked on", () => {
  // The agent may be reached on a port of its own choosing; naming the default
  // 2208 would leave a shell on any other port framed by nobody.
  assert.equal(appOriginFor("sites.localhost:3000"), "http://localhost:3000");
  assert.equal(appOriginFor("sites.localhost"), "http://localhost:2208");
  assert.equal(appOriginFor("sites.127.0.0.1:2208"), "http://127.0.0.1:2208");
  // Unknown host: no app origin, so nothing but the shell itself may frame it.
  assert.equal(appOriginFor("sites.evil.tld"), "");
});

test("a malformed host header is not the sites host", () => {
  // An unterminated IPv6 literal used to slice to "" and then match nothing —
  // but the bracket form must not be read as a name either.
  for (const h of ["[::1", "[", "[]", ""]) {
    assert.equal(isSitesHost(h), false, `accepted ${JSON.stringify(h)}`);
  }
  // A bracketed loopback literal is still not one of our names.
  assert.equal(isSitesHost("[::1]:2208"), false);
  // A junk port after the real name still names the real host, and only reaches
  // the same site surface that host already serves.
  assert.equal(isSitesHost("sites.localhost:2208:9"), true);
});

test("a path that parse cannot read is refused, not thrown", () => {
  // serveSitesHost reads req.url with url.parse, which throws on a few inputs;
  // the failure must stay a 400 and never reach the file read.
  for (const p of ["/%", "/browse/%zz", "//["]) {
    const route = routeSitesLocalRequest(p, "sites.localhost:2208");
    assert.ok(route === null || route.kind === "browse", `unexpected route for ${p}`);
  }
});

test("the transport can tell this host apart", () => {
  // engine.io refuses the handshake on this host, so a page inside a browsed
  // site cannot open the socket that reaches the whole API. The check is the
  // same predicate the router uses.
  assert.equal(isSitesHost("sites.localhost:2208"), true);
  assert.equal(isSitesHost("localhost:2208"), false);
  assert.equal(isSitesHost("127.0.0.1:2208"), false);
});

test("no CORS header is set on this origin", () => {
  for (const p of ["/", "/proxy.html", "/sw-site.js", "/browse/3000/"]) {
    assert.equal(routeSitesLocalRequest(p, "sites.localhost:2208").headers["Access-Control-Allow-Origin"], undefined, `set on ${p}`);
  }
});
