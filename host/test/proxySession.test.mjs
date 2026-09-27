// /proxy/<port>/ is a public route: it reaches the tunnel, and its only gate was
// "is a session open for this port". Ports are guessable — 3000, 5173, 8080 —
// so while the user had a site open, anyone who knew the tunnel hostname could
// read that same dev server by typing the number.
//
// The session id goes in the path instead, which is how /preview/ already works
// (previewServer.js mints a randomUUID and routes on it). The port moves to the
// server side of the map, where a caller cannot choose it.
// Run: node --test agent/test/proxySession.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startProxySession, endProxySession, resolveProxySession, isProxySessionActive
} from "../proxy/index.js";
import { SERVER_PORT } from "../lib/constants.js";

test("starting a session returns an id that resolves to the port", () => {
  const id = startProxySession(3000);
  assert.equal(typeof id, "string");
  assert.equal(resolveProxySession(id), 3000);
  endProxySession(3000);
});

test("the id is not the port", () => {
  // The whole point: a caller must not be able to construct the URL from a
  // number they guessed.
  const id = startProxySession(3000);
  assert.notEqual(id, "3000");
  assert.ok(!id.includes("3000"), `port leaked into ${id}`);
  endProxySession(3000);
});

test("the id is long enough not to be walked", () => {
  const id = startProxySession(3000);
  assert.ok(id.length >= 32, `id too short: ${id.length} chars`);
  assert.match(id, /^[0-9a-f-]+$/, "expected a uuid");
  endProxySession(3000);
});

test("two sessions on different ports get different ids", () => {
  const a = startProxySession(3000);
  const b = startProxySession(5173);
  assert.notEqual(a, b);
  assert.equal(resolveProxySession(a), 3000);
  assert.equal(resolveProxySession(b), 5173);
  endProxySession(3000);
  endProxySession(5173);
});

test("restarting the same port reuses its id", () => {
  // SitesList calls start again when a window is reopened; a second id would
  // orphan the first and leak entries.
  const a = startProxySession(3000);
  const b = startProxySession(3000);
  assert.equal(a, b);
  endProxySession(3000);
});

test("an unknown id resolves to nothing", () => {
  assert.equal(resolveProxySession("00000000-0000-4000-8000-000000000000"), null);
  assert.equal(resolveProxySession(""), null);
  assert.equal(resolveProxySession(null), null);
  assert.equal(resolveProxySession("3000"), null, "the port must not work as an id");
});

test("ending a session makes its id stop resolving", () => {
  const id = startProxySession(3000);
  endProxySession(3000);
  assert.equal(resolveProxySession(id), null);
});

test("an id from a closed session does not come back", () => {
  // Reusing an id across sessions would let a stale link work again later.
  const first = startProxySession(3000);
  endProxySession(3000);
  const second = startProxySession(3000);
  assert.notEqual(first, second);
  assert.equal(resolveProxySession(first), null);
  endProxySession(3000);
});

test("the port check still answers for the bus handler", () => {
  // site:httpRequest carries a port, not an id — it runs over an authenticated
  // socket, so the port is the right question there.
  startProxySession(3000);
  assert.equal(isProxySessionActive(3000), true);
  assert.equal(isProxySessionActive(9999), false);
  endProxySession(3000);
});

test("the agent's own port is refused", () => {
  // A proxy session to ourselves would launder requests through the agent:
  // they reach the private routes from loopback with a local Host, so neither
  // guard sees anything wrong, and /api/ui/state returns the permanent key.
  assert.equal(startProxySession(SERVER_PORT), null);
  assert.equal(isProxySessionActive(SERVER_PORT), false);
});

test("a bad port is refused rather than stored", () => {
  assert.equal(startProxySession("not-a-port"), null);
  assert.equal(startProxySession(0), null);
  assert.equal(startProxySession(70000), null);
  assert.equal(startProxySession(null), null);
});
