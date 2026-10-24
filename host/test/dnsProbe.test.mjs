// Run: node host/test/dnsProbe.test.mjs
import assert from "node:assert/strict";
import dns from "node:dns";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const originalResolver = dns.promises.Resolver;
const originalLookup = dns.lookup;
const pending = () => new Promise(() => {});
const failure = (code) => Promise.reject(Object.assign(new Error(code), { code }));
let resolve4 = () => Promise.resolve(["192.0.2.1"]);
let resolve6 = () => Promise.resolve(["2001:db8::1"]);

dns.promises.Resolver = class {
  setServers() {}
  resolve4(hostname) { return resolve4(hostname); }
  resolve6(hostname) { return resolve6(hostname); }
};
let resolveTunnelDns, probeTunnelOnce;
try {
  ({ resolveTunnelDns, probeTunnelOnce } = await import("../cli/utils/dnsProbe.js"));
} finally {
  dns.promises.Resolver = originalResolver;
  dns.lookup = originalLookup;
}

if (process.argv.includes("--exit-probe")) {
  await resolveTunnelDns("tunnel.example", 60000);
  console.log("probe completed");
} else {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (error) { fail++; console.error(`  ✗ ${name}\n    ${error.message}`); }
  };
  const probe = () => resolveTunnelDns("tunnel.example", 40);

  await test("IPv4 succeeds while IPv6 never answers", async () => {
    resolve4 = () => Promise.resolve(["192.0.2.1"]);
    resolve6 = pending;
    const result = await probe();
    assert.equal(result.ok, true);
    assert.deepEqual(result.addrs, ["192.0.2.1"]);
    assert.ok(result.elapsedMs >= 0);
  });

  await test("IPv6 succeeds while IPv4 never answers", async () => {
    resolve4 = pending;
    resolve6 = () => Promise.resolve(["2001:db8::1"]);
    const result = await probe();
    assert.equal(result.ok, true);
    assert.deepEqual(result.addrs, ["2001:db8::1"]);
  });

  await test("a rejected IPv4 query does not discard a usable IPv6 answer", async () => {
    resolve4 = () => failure("ENOTFOUND");
    resolve6 = () => Promise.resolve(["2001:db8::1"]);
    assert.deepEqual((await probe()).addrs, ["2001:db8::1"]);
  });

  await test("an empty answer cannot win over a pending valid answer", async () => {
    resolve4 = () => Promise.resolve([]);
    resolve6 = () => new Promise((resolve) => setTimeout(() => resolve(["2001:db8::1"]), 5));
    assert.deepEqual((await probe()).addrs, ["2001:db8::1"]);
  });

  await test("both failed families preserve the IPv4 error code", async () => {
    resolve4 = () => failure("ESERVFAIL");
    resolve6 = () => failure("ENOTFOUND");
    const result = await probe();
    assert.equal(result.ok, false);
    assert.equal(result.code, "ESERVFAIL");
  });

  await test("an empty IPv4 response preserves the real IPv6 error", async () => {
    resolve4 = () => Promise.resolve([]);
    resolve6 = () => failure("ESERVFAIL");
    assert.equal((await probe()).code, "ESERVFAIL");
  });

  await test("two empty responses report ENOTFOUND", async () => {
    resolve4 = () => Promise.resolve([]);
    resolve6 = () => Promise.resolve([]);
    const result = await probe();
    assert.equal(result.ok, false);
    assert.equal(result.code, "ENOTFOUND");
  });

  await test("the total timeout still bounds two stalled queries", async () => {
    resolve4 = pending;
    resolve6 = pending;
    const result = await probe();
    assert.equal(result.ok, false);
    assert.equal(result.code, "ETIMEOUT");
  });

  await test("a usable family allows the tunnel HTTP health probe to proceed", async () => {
    resolve4 = pending;
    resolve6 = () => Promise.resolve(["2001:db8::1"]);
    const originalFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200 };
    };
    try {
      const result = await probeTunnelOnce("https://tunnel.example");
      assert.equal(result.ok, true);
      assert.deepEqual(fetched, ["https://tunnel.example/api/health"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("a completed probe does not keep a short-lived process alive", async () => {
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--exit-probe"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const watchdog = setTimeout(() => child.kill(), 1500);
      child.on("error", (error) => { clearTimeout(watchdog); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(watchdog);
        resolve({ code, signal, output });
      });
    });
    assert.match(outcome.output, /probe completed/);
    assert.equal(outcome.signal, null, "probe left its timeout running");
    assert.equal(outcome.code, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
