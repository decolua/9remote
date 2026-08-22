// The origin guard wired into the router, exercised over a real socket so the
// loopback check, the CORS headers and the route table all take part.
// Run: node --test agent/test/routerOrigin.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRouter, jsonOk } from "../lib/router.js";

const ROUTES = [
  { path: "/api/health", method: "GET", public: true, handler: (req, res) => jsonOk(res, { ok: true }) },
  { path: "/api/key/one-time", method: "POST", handler: (req, res) => jsonOk(res, { oneTimeKey: "SECRET" }) },
  { path: "/api/ui/state", method: "GET", handler: (req, res) => jsonOk(res, { permanentKey: "sk-secret" }) }
];

let server, base;

before(async () => {
  server = createServer(createRouter(ROUTES, { fallback: (req, res) => { res.writeHead(404); res.end(); } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (path, { origin, method = "GET" } = {}) =>
  fetch(base + path, { method, headers: origin ? { Origin: origin } : {} });

test("evil.com cannot mint a pairing code", async () => {
  // The reported attack, end to end: a page in another tab posting here.
  const res = await call("/api/key/one-time", { origin: "https://evil.com", method: "POST" });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes("SECRET"), "handler ran anyway");
});

test("evil.com cannot read the ui state", async () => {
  const res = await call("/api/ui/state", { origin: "https://evil.com" });
  assert.equal(res.status, 403);
});

test("even refused, no CORS grant is handed out", async () => {
  // A 403 the page can read is still a 403; what matters is that it never gets
  // permission to read a success either.
  const res = await call("/api/ui/state", { origin: "https://evil.com" });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("the agent UI still works", async () => {
  const res = await call("/api/ui/state", { origin: "http://localhost:2208" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).permanentKey, "sk-secret");
});

test("the UI is granted CORS for its own origin", async () => {
  const res = await call("/api/ui/state", { origin: "http://localhost:2208" });
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:2208");
  assert.equal(res.headers.get("vary"), "Origin");
});

test("node callers with no Origin still work", async () => {
  // tunnelHealth polls this one; hookManager posts to /api/notify.
  const res = await call("/api/ui/state");
  assert.equal(res.status, 200);
});

test("a public route stays reachable cross-origin", async () => {
  const res = await call("/api/health", { origin: "https://9remote.cc" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://9remote.cc");
});

test("no response carries the wildcard", async () => {
  for (const [path, origin] of [
    ["/api/health", "https://9remote.cc"],
    ["/api/health", "https://evil.com"],
    ["/api/ui/state", "http://localhost:2208"],
    ["/api/ui/state", "https://evil.com"]
  ]) {
    const res = await call(path, { origin });
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*", `${path} from ${origin}`);
  }
});

test("preflight is answered without running the handler", async () => {
  const res = await call("/api/key/one-time", { origin: "http://localhost:2208", method: "OPTIONS" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});
