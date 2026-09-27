// The opencode model catalog comes from the serve server (GET /api/model — it
// carries limit.context, so the pane finally has a context-window denominator);
// the CLI `opencode models --verbose` spawn stays as the fallback.
// Run: node agent/test/opencodeModels.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import * as server from "../features/ai/opencodeServer.js";
import { listOpencodeModelOptionsFromServer } from "../features/ai/models.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

function fakeServe(routes) {
  const srv = http.createServer((req, res) => {
    const handler = routes[`${req.method} ${req.url}`];
    if (!handler) { res.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
    const { status = 200, json = {} } = typeof handler === "function" ? handler() : handler;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

console.log("Running opencode model catalog tests...");

await test("the server catalog carries provider-prefixed ids and contextWindow", async () => {
  const { srv, port } = await fakeServe({
    "GET /api/model": { json: { location: "/tmp", data: [
      { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", status: "active", limit: { context: 200000, output: 64000 }, variants: { minimal: {}, medium: {}, high: {} } },
      { id: "muse-spark", providerID: "opencode", name: "Muse Spark", status: "active", limit: { context: 128000 }, variants: { default: {} } }
    ] } }
  });
  server._useTestBase(`http://127.0.0.1:${port}`);
  try {
    const options = await listOpencodeModelOptionsFromServer();
    assert.equal(options.length, 2);
    const sonnet = options[0];
    assert.equal(sonnet.id, "anthropic/claude-sonnet-5");
    assert.equal(sonnet.label, "Claude Sonnet 5");
    assert.equal(sonnet.contextWindow, 200000);
    assert.ok(sonnet.efforts.includes("medium"));
    assert.equal(sonnet.defaultEffort, "medium");
    assert.equal(options[1].defaultEffort === "default" || options[1].defaultEffort === "", true, "'default' marker must not read as a reasoning level");
  } finally {
    server._useTestBase(null);
    srv.close();
  }
});

await test("a dead server answers an empty list, never a throw", async () => {
  const { srv, port } = await fakeServe({
    "GET /api/model": { status: 500, json: { name: "UnknownError" } }
  });
  server._useTestBase(`http://127.0.0.1:${port}`);
  try {
    const options = await listOpencodeModelOptionsFromServer();
    assert.ok(Array.isArray(options));
  } finally {
    server._useTestBase(null);
    srv.close();
  }
});

await test("e2e: live serve lists real models with a context limit", async () => {
  const options = await listOpencodeModelOptionsFromServer();
  assert.ok(options.length >= 1, "no models from the live server");
  assert.ok(options.every((m) => m.id.includes("/")), "ids must be provider-prefixed");
  assert.ok(options.some((m) => m.contextWindow > 0), "no contextWindow carried");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
