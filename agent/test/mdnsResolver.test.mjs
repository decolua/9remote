// Regression tests for mdnsResolver — the .local → IP step that decides whether
// a same-LAN ICE pair exists at all. Real resolver, NO mocks.
// Run: node agent/test/mdnsResolver.test.mjs
//
// Background: getaddrinfo does not consult mDNSResponder on macOS, so
// dns.lookup(".local") always failed there and every LAN candidate from the
// browser was silently dropped → ICE fell back to srflx (round trip over WAN).
import assert from "node:assert/strict";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parseLocalHost, resolveCandidate, _resetCache, closeMdns } from "../lib/mdnsResolver.js";

let pass = 0, fail = 0, skip = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) {
    if (e?.skip) { skip++; console.log(`  ~ ${name} (skipped: ${e.message})`); return; }
    fail++; console.error(`  ✗ ${name}\n    ${e.message}`);
  }
};
const skipTest = (why) => { const e = new Error(why); e.skip = true; throw e; };

const cand = (host) => `candidate:2759419408 1 udp 2113939711 ${host} 64746 typ host generation 0 ufrag TPXt network-cost 999`;
const UUID_HOST = "3880416e-d0a4-4dba-8f2b-60b94c1cd67f.local";
// A real-looking name nothing on the LAN owns — used to exercise a genuine
// query + negative cache (a UUID name is now short-circuited, never queried).
const DEAD_HOST = "no-such-host-9remote-test.local";

console.log(`\nSuite 1: parseLocalHost`);

await test("extracts the .local hostname from a candidate line", () => {
  assert.equal(parseLocalHost(cand(DEAD_HOST)), DEAD_HOST);
});

// A browser answers its per-session UUID name only inside its own WebRTC stack,
// so dns-sd/multicast never get a reply — querying only burns MDNS_TIMEOUT_MS.
await test("skips a browser's ephemeral UUID hostname without querying", () => {
  assert.equal(parseLocalHost(cand(UUID_HOST)), null);
});

await test("returns null for a plain IPv4 candidate", () => {
  assert.equal(parseLocalHost(cand("192.168.1.9")), null);
});

await test("returns null for an IPv6 candidate", () => {
  assert.equal(parseLocalHost(cand("fdc0:d74c:b797:6c9d:cc2:131:ddf2:920b")), null);
});

await test("matches a non-hex .local name (Safari/Avahi are not UUID-only)", () => {
  assert.equal(parseLocalHost(cand("hoangs-macbook-air.local")), "hoangs-macbook-air.local");
});

console.log(`\nSuite 1b: hostname validation — candidates are remote input`);

// The hostname reaches dns-sd as an argv element (execFile, no shell), so these
// cannot inject a command. Rejecting them keeps junk out of the resolver anyway.
for (const bad of [
  "; touch /tmp/pwned ;x.local",
  "$(id).local",
  "`id`.local",
  "--version.local",
  "-G.local",
  "a/../../etc/passwd.local"
]) {
  await test(`rejects hostile hostname: ${bad}`, () => {
    assert.equal(parseLocalHost(cand(bad)), null);
  });
}

await test("rejects an over-long hostname", () => {
  assert.equal(parseLocalHost(cand("a".repeat(300) + ".local")), null);
});

await test("a rejected .local is dropped, not passed through unresolved", async () => {
  _resetCache();
  // Returning the line verbatim would hand ICE a hostname it cannot use.
  assert.equal(await resolveCandidate(cand("$(id).local")), null);
});

console.log(`\nSuite 2: resolveCandidate — pass-through and failure`);

await test("a candidate without .local is returned verbatim", async () => {
  _resetCache();
  const line = cand("192.168.1.9");
  assert.equal(await resolveCandidate(line), line);
});

await test("an unresolvable .local yields null (caller must drop it)", async () => {
  _resetCache();
  assert.equal(await resolveCandidate(cand(DEAD_HOST)), null);
});

console.log(`\nSuite 3: caching`);

await test("a failure is cached — the second call does not re-query", async () => {
  _resetCache();
  const t0 = Date.now();
  await resolveCandidate(cand(DEAD_HOST));
  const cold = Date.now() - t0;

  const t1 = Date.now();
  await resolveCandidate(cand(DEAD_HOST));
  const warm = Date.now() - t1;

  assert.ok(cold > 100, `precondition: cold miss should take a real query (got ${cold}ms)`);
  assert.ok(warm < 50, `cached failure should return immediately (got ${warm}ms)`);
});

await test("concurrent calls for one hostname share a single query", async () => {
  _resetCache();
  const t0 = Date.now();
  const results = await Promise.all([
    resolveCandidate(cand(DEAD_HOST)),
    resolveCandidate(cand(DEAD_HOST)),
    resolveCandidate(cand(DEAD_HOST))
  ]);
  const elapsed = Date.now() - t0;
  assert.deepEqual(results, [null, null, null]);
  // Serialised queries would cost ~3× the single-query timeout.
  assert.ok(elapsed < 2500, `3 concurrent lookups should coalesce (got ${elapsed}ms)`);
});

await test("the cache is bounded — unique hostnames cannot grow it forever", async () => {
  _resetCache();
  // 300 distinct names > CACHE_MAX (256). Each is unresolvable but must be
  // answered from the negative cache on the second pass, i.e. no re-query.
  const names = Array.from({ length: 300 }, (_, i) => `no-such-9remote-${i}.local`);
  await Promise.all(names.map((n) => resolveCandidate(cand(n))));

  // The newest entries survive eviction, so re-asking for them is instant.
  const t0 = Date.now();
  await Promise.all(names.slice(-50).map((n) => resolveCandidate(cand(n))));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `recent entries should still be cached (got ${elapsed}ms)`);
});

console.log(`\nSuite 4: integration — real mDNS on this host`);

// Ground truth: every non-loopback IPv4 this host owns. A machine has several
// (Wi-Fi, VM bridges) and mDNS may legitimately answer with any of them, so the
// assertion is membership, not equality.
function ownIpv4s() {
  const fromOs = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  if (process.platform !== "darwin") return fromOs;
  try {
    const out = execFileSync("dscacheutil", ["-q", "host", "-a", "name", os.hostname()], { encoding: "utf8" });
    const fromDs = (out.match(/ip_address:\s*(\d+\.\d+\.\d+\.\d+)/g) || [])
      .map((l) => l.split(/\s+/)[1])
      .filter((ip) => ip !== "127.0.0.1");
    return [...new Set([...fromOs, ...fromDs])];
  } catch { return fromOs; }
}

// mDNSResponder suppresses a duplicate question for the same name within ~1s,
// so the integration cases share one resolution instead of querying twice.
const OWN_IPS = ownIpv4s();
const OWN_LINE = cand(os.hostname());
_resetCache();
const ownResolved = OWN_IPS.length ? await resolveCandidate(OWN_LINE) : null;

await test("resolves this machine's own .local to a LAN IPv4", async () => {
  if (!OWN_IPS.length) skipTest("host has no non-loopback IPv4");
  assert.ok(ownResolved, "own .local hostname must resolve — this is the LAN-pair fix");
  const ip = ownResolved.split(/\s+/)[4];
  assert.ok(OWN_IPS.includes(ip), `resolved ${ip} is not one of this host's IPs: ${OWN_IPS.join(", ")}`);
});

await test("resolution rewrites only the hostname, leaving the line intact", async () => {
  if (!ownResolved) skipTest("own .local hostname did not resolve");
  assert.ok(!/\.local/i.test(ownResolved), `hostname must be replaced: ${ownResolved}`);
  assert.ok(ownResolved.startsWith("candidate:2759419408 1 udp 2113939711 "), "prefix preserved");
  assert.ok(ownResolved.endsWith(" 64746 typ host generation 0 ufrag TPXt network-cost 999"), "suffix preserved");
  assert.equal(ownResolved.split(/\s+/).length, OWN_LINE.split(/\s+/).length, "token count unchanged");
});

closeMdns();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
