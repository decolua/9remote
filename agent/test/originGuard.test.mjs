// The local API is reachable from any page the user has open.
//
// The router's only gate was the TCP peer address, and a browser IS the
// loopback peer — so evil.com could POST to localhost:2208 and, because every
// response carried Access-Control-Allow-Origin: *, read what came back. That is
// enough to mint a pairing code, read it, turn on auto-approve, and walk in.
//
// Node callers (the CLI's own health checks, hook notifications) send no Origin
// at all and must keep working, so absence is allowed and only a WRONG origin
// is refused.
// Run: node --test agent/test/originGuard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, corsOriginFor } from "../middleware/cors.js";

const UI = "http://localhost:2208";
const UI_IP = "http://127.0.0.1:2208";
const VITE = "http://localhost:5173";

test("the agent UI's own origin is allowed", () => {
  assert.equal(isAllowedOrigin(UI), true);
  assert.equal(isAllowedOrigin(UI_IP), true);
});

test("the vite dev server is allowed", () => {
  // npm run dev:ui serves the UI from vite while the API stays on 2208.
  assert.equal(isAllowedOrigin(VITE), true);
});

test("a request with no Origin is allowed", () => {
  // Node has no Origin: the CLI polls /api/health and /api/ui/state, and
  // hookManager posts to /api/notify. Refusing these would break the agent's
  // own plumbing while stopping no browser.
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(null), true);
  assert.equal(isAllowedOrigin(""), true);
});

test("an arbitrary site is refused", () => {
  // The attack: a page the user has open in another tab.
  assert.equal(isAllowedOrigin("https://evil.com"), false);
  assert.equal(isAllowedOrigin("http://evil.com"), false);
});

test("a null origin is refused", () => {
  // Sandboxed iframes and some redirects send the literal string "null".
  // Treating it as "no origin" would hand every sandboxed frame a way in.
  assert.equal(isAllowedOrigin("null"), false);
});

test("a lookalike host is refused", () => {
  // Substring or prefix matching would accept all of these.
  assert.equal(isAllowedOrigin("http://localhost:2208.evil.com"), false);
  assert.equal(isAllowedOrigin("http://evil-localhost:2208"), false);
  assert.equal(isAllowedOrigin("http://localhost:22080"), false);
  assert.equal(isAllowedOrigin("https://localhost:2208"), false, "scheme must match too");
});

test("another port on localhost is refused", () => {
  // A dev server the user is running is still not the agent UI.
  assert.equal(isAllowedOrigin("http://localhost:3000"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8080"), false);
});

test("a public route echoes the caller's origin, never a wildcard", () => {
  // Tunnel routes are called cross-origin by the web app, so they need CORS —
  // but "*" let any page read them. The web app's own origin varies per deploy,
  // so the header echoes what asked rather than naming one.
  assert.equal(corsOriginFor("https://9remote.cc", true), "https://9remote.cc");
  assert.equal(corsOriginFor("https://dev.9remote.cc", true), "https://dev.9remote.cc");
});

test("a private route grants CORS only to the local UI", () => {
  assert.equal(corsOriginFor(UI, false), UI);
  assert.equal(corsOriginFor("https://evil.com", false), null);
});

test("no origin means no CORS header at all", () => {
  // Nothing to grant: a Node caller is not subject to the same-origin policy,
  // and emitting a header would only invite copying it somewhere it matters.
  assert.equal(corsOriginFor(undefined, false), null);
  assert.equal(corsOriginFor(undefined, true), null);
});

test("the wildcard is never returned", () => {
  // Including when a caller literally sends Origin: * — echoing that back would
  // reintroduce exactly what this replaces.
  for (const origin of ["https://evil.com", "null", UI, undefined, "*"]) {
    for (const isPublic of [true, false]) {
      assert.notEqual(corsOriginFor(origin, isPublic), "*", `wildcard for ${origin}/${isPublic}`);
    }
  }
});
