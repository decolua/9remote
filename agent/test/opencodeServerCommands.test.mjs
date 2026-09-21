// opencode serve command surface: listCommands (GET /command v1), runCommand
// (POST /session/:id/command v1), and the SPA-trap guard (unknown /api/* paths
// answer 200 text/html — measured on 1.18.31).
// Run: node agent/test/opencodeServerCommands.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import * as server from "../features/ai/opencodeServer.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

// Fake opencode serve: records requests, answers from `routes`.
function fakeServe(routes) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      const key = `${req.method} ${req.url}`;
      const handler = routes[key];
      if (!handler) { res.writeHead(404).end("{}"); return; }
      const { status = 200, json = {}, contentType = "application/json", calls: hcalls } = typeof handler === "function" ? handler() : handler;
      hcalls?.();
      res.writeHead(status, { "content-type": contentType });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, calls, port: srv.address().port })));
}

console.log("Running opencode server command tests...");

const COMMANDS = [
  { name: "init", description: "guided AGENTS.md setup", source: "command" },
  { name: "review", description: "review changes [commit|branch|pr]", source: "command" },
];

await test("listCommands reads GET /command and retries once on warmup-empty", async () => {
  let served = 0;
  const { srv, calls, port } = await fakeServe({
    "GET /command": () => (served++ === 0 ? { json: [] } : { json: COMMANDS }),
  });
  server._useTestBase(`http://127.0.0.1:${port}`);
  try {
    const cmds = await server.listCommands();
    assert.equal(served, 2, "empty first answer must trigger exactly one retry");
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0].name, "init");
    assert.equal(cmds[0].description, "guided AGENTS.md setup");
    assert.equal(calls[0].path, "/command");
  } finally {
    server._useTestBase(null);
    srv.close();
  }
});

await test("runCommand posts {command, arguments} to the v1 session command route", async () => {
  const { srv, calls, port } = await fakeServe({
    "POST /session/ses_x/command": { json: { ok: true } },
  });
  server._useTestBase(`http://127.0.0.1:${port}`);
  try {
    await server.runCommand("ses_x", { command: "review", arguments: "pr", model: "anthropic/claude-sonnet-5", variant: "high" });
    const call = calls.find((c) => c.path === "/session/ses_x/command");
    assert.ok(call, "command route not called");
    assert.equal(call.body.command, "review");
    assert.equal(call.body.arguments, "pr");
    assert.equal(call.body.model, "anthropic/claude-sonnet-5");
    assert.equal(call.body.variant, "high");
  } finally {
    server._useTestBase(null);
    srv.close();
  }
});

await test("a 200 text/html answer (SPA trap) is an error, not data", async () => {
  const { srv, port } = await fakeServe({
    "GET /api/session/nope/message": { json: { html: true }, contentType: "text/html" },
    "POST /api/session/nope/interrupt": { json: { html: true }, contentType: "text/html" },
  });
  server._useTestBase(`http://127.0.0.1:${port}`);
  try {
    await assert.rejects(() => server.listMessages("nope"), /unavailable|HTML/i);
    // The raw-fetch paths must guard the same trap (audited RISK-3).
    await assert.rejects(() => server.interruptSession("nope"), /unavailable|HTML|interrupt/i);
  } finally {
    server._useTestBase(null);
    srv.close();
  }
});

// e2e: the real shared server (spawns/adopts on 41998 like the app itself).
await test("e2e: live serve lists its real command set", async () => {
  const cmds = await server.listCommands();
  const names = cmds.map((c) => c.name);
  assert.ok(names.includes("init"), "built-in /init missing");
  assert.ok(names.includes("review"), "built-in /review missing");
  assert.ok(cmds.length >= 2, `expected the full menu, got ${cmds.length}`);
  assert.ok(cmds.every((c) => typeof c.description === "string" || c.description === undefined));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
