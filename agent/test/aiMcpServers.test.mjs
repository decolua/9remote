// Which MCP servers each engine reports.
//
// Two things were wrong, both reported from real use of the modal:
//   • the codex reader ran for EVERY engine, so claude's servers were listed as codex's
//     and opencode/antigravity — with no reader at all — showed claude's list as theirs;
//   • it matched the TOML heading alone, and codex nests options under a server
//     (`[mcp_servers."9remote".http_headers]`), so option tables were listed as servers
//     of their own, named after the option.
//
// HOME IS REWRITTEN BEFORE THE MODULE LOADS. The readers resolve `os.homedir()` per call,
// so pointing HOME at a throwaway directory is what keeps a test from ever touching the
// user's real config — the failure mode that matters more than anything this asserts.
//
// Run: node agent/test/aiMcpServers.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The real home, captured BEFORE anything points HOME elsewhere, so the last test can
// prove it was never written to.
const REAL_HOME = os.homedir();
const realFiles = [".claude/settings.json", ".codex/config.toml"].map((rel) => {
  const p = path.join(REAL_HOME, rel);
  let stat = null;
  try { stat = fs.statSync(p); } catch {}
  return { rel, exists: Boolean(stat), mtimeMs: stat?.mtimeMs ?? null, size: stat?.size ?? null };
});

// Must happen before the import below: a module that captured the path at load time would
// otherwise read the real home.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-mcp-home-"));
process.env.HOME = sandbox;

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const write = (rel, text) => {
  const p = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

write(".claude/settings.json", JSON.stringify({
  mcpServers: { exa: { command: "exa-mcp" }, "remote-thing": { url: "https://x/mcp" } }
}));
write(".codex/config.toml", [
  "[mcp_servers.node_repl]",
  'command = "node_repl"',
  "[mcp_servers.node_repl.env]",
  'FOO = "bar"',
  '[mcp_servers."9remote"]',
  'url = "https://9remote.cc/mcp"',
  '[mcp_servers."9remote".http_headers]',
  'Authorization = "Bearer x"',
  "[mcp_servers.computer-use]",
  'command = "cu"'
].join("\n"));

const { listMcpServers } = await import("../features/ai/mcp.js");

test("each engine reports its OWN servers", () => {
  assert.deepEqual(listMcpServers("claude").map((s) => s.name), ["exa", "remote-thing"]);
  assert.deepEqual(listMcpServers("codex").map((s) => s.name), ["node_repl", "9remote", "computer-use"]);
});

test("an option table is not a server", () => {
  // `.env` and `.http_headers` are keys OF a server, not servers.
  const names = listMcpServers("codex").map((s) => s.name);
  for (const phantom of ["node_repl.env", "9remote.http_headers"]) {
    assert.ok(!names.includes(phantom), `${phantom} is an option, not a server`);
  }
});

test("an engine with no reader of its own reports nothing, not another's", () => {
  assert.deepEqual(listMcpServers("opencode"), []);
  assert.deepEqual(listMcpServers("antigravity"), []);
});

test("a quoted name keeps its real name", () => {
  assert.ok(listMcpServers("codex").some((s) => s.name === "9remote"), "quotes are not part of the name");
});

test("an http server is typed by its url", () => {
  const remote = listMcpServers("claude").find((s) => s.name === "remote-thing");
  assert.equal(remote.type, "http");
  assert.match(remote.command, /^https:/);
});

test("a missing or broken config is an empty list, not a throw", () => {
  write(".codex/config.toml", "not = [ valid");
  assert.deepEqual(listMcpServers("codex"), []);
  fs.rmSync(path.join(sandbox, ".codex/config.toml"), { force: true });
  assert.deepEqual(listMcpServers("codex"), []);
});

// The whole point of the sandbox: this file must not be able to touch the user's config,
// however wrong its assertions are. Verified, not assumed.
test("the real home's configs are untouched", () => {
  for (const before of realFiles) {
    const p = path.join(REAL_HOME, before.rel);
    let stat = null;
    try { stat = fs.statSync(p); } catch {}
    assert.equal(Boolean(stat), before.exists, `${before.rel} appeared or vanished`);
    if (!stat) continue;
    assert.equal(stat.size, before.size, `${before.rel} changed size`);
    assert.equal(stat.mtimeMs, before.mtimeMs, `${before.rel} was written to`);
  }
});

// And the module really read the sandbox — otherwise every assertion above is vacuous.
test("the module read the sandbox home, not the real one", () => {
  assert.equal(os.homedir(), sandbox);
  // The fixture is rewritten here because the test above deliberately broke it; what this
  // checks is that a server placed in the SANDBOX comes back, so the reads are not somehow
  // still pointed at the real home.
  write(".codex/config.toml", "[mcp_servers.sandbox-only]\ncommand = \"x\"\n");
  assert.deepEqual(listMcpServers("codex").map((s) => s.name), ["sandbox-only"]);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
