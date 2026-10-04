// Behavioral parity guard for web/hotRoutes.js — the verbatim copy of the three
// hot session routes that injectHotRoutes.mjs serves from the outer worker.
// It exercises the real exported entry (handleHotRoutes) against a fake D1 and
// REAL Ed25519 signatures, so a drifted copy of the auth logic fails here
// before it ever reaches production.
// Run: node --import ./test/loader-alias.mjs web/test/hotRoutes.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handleHotRoutes } from "../hotRoutes.js";
import { mutationPayload } from "../shared/utils/sessionMutationAuth.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Minimal in-memory D1: enough for SELECT/INSERT..ON CONFLICT/UPDATE shapes the
// three routes issue. Rows live in Maps; bind() args substitute the single "?".
function fakeDb() {
  const sessions = new Map(); // apiKey -> row object
  const tempKeys = [];        // { temp_key, api_key, expires_at }
  const run = (sql, args) => {
    if (sql.includes("FROM temp_keys")) {
      const [tk, ak, now] = args;
      return tempKeys.find((t) => t.temp_key === tk && t.api_key === ak && t.expires_at > now) ? { ok: 1 } : undefined;
    }
    if (sql.includes("SELECT hostPublicKey FROM sessions")) {
      return sessions.get(args[0]);
    }
    if (sql.includes("INSERT INTO sessions")) {
      const [machineId, apiKey, hostPublicKey, hostX25519Key] = args;
      const existing = sessions.get(apiKey);
      const stored = sql.includes("COALESCE")
        ? { ...(existing || {}), machineId, hostPublicKey: hostPublicKey ?? existing?.hostPublicKey ?? null, hostX25519Key: hostX25519Key ?? existing?.hostX25519Key ?? null, tunnelUrl: null }
        : { machineId, apiKey, hostPublicKey, hostX25519Key, tunnelUrl: null };
      sessions.set(apiKey, { ...existing, ...stored });
      return undefined;
    }
    if (sql.includes("UPDATE sessions SET agentOnline")) {
      const row = sessions.get(args[1]);
      if (row) { row.agentOnline = args[0]; row.agentSeenAt = "now"; }
      return undefined;
    }
    if (sql.includes("UPDATE sessions SET tunnelUrl")) {
      const [tunnelUrl, publicIp, localIp, apiKey] = args;
      const row = sessions.get(apiKey);
      if (row) Object.assign(row, { tunnelUrl, publicIp, localIp });
      return undefined;
    }
    throw new Error(`fakeDb: unhandled SQL: ${sql.slice(0, 60)}`);
  };
  return {
    sessions, tempKeys,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => run(sql, args),
        run: async () => { run(sql, args); return { meta: { changes: 1 } }; },
      }),
    }),
  };
}

// Host-style Ed25519 signing: raw 32-byte public key in base64, sign the exact
// mutationPayload bytes.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubRawB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const sign = (body) => crypto.sign(null, Buffer.from(mutationPayload(body), "utf8"), privateKey).toString("base64");

const API_KEY = "sk-abcd1234-qrstuvwx-yz234567"; // shape-valid v2 HEAD
const env = (db) => ({ DB: db });
const post = (path, body, headers = {}) => new Request(`https://9remote.cc${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});

console.log("hotRoutes — hot session API copy");

await test("unknown /api/session path falls through to Next (null)", async () => {
  assert.equal(await handleHotRoutes(new Request("https://9remote.cc/api/session/delete", { method: "POST" }), env(fakeDb())), null);
});

await test("non-POST falls through (Next answers 405 as before)", async () => {
  assert.equal(await handleHotRoutes(new Request("https://9remote.cc/api/session/heartbeat", { method: "GET" }), env(fakeDb())), null);
});

await test("OPTIONS returns the same CORS preflight the Next route did", async () => {
  const res = await handleHotRoutes(new Request("https://9remote.cc/api/session/heartbeat", { method: "OPTIONS" }), env(fakeDb()));
  assert.ok(res instanceof Response);
  assert.ok(res.headers.get("Access-Control-Allow-Origin"));
});

await test("heartbeat: no registered key → accepted (legacy row)", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: null });
  const res = await handleHotRoutes(post("/api/session/heartbeat", { apiKey: API_KEY, online: 1 }), env(db));
  assert.equal(res.status, 200);
  assert.equal(db.sessions.get(API_KEY).agentOnline, 1);
});

await test("heartbeat: valid Ed25519 signature → 200, online written", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const ts = Date.now();
  const body = { apiKey: API_KEY, online: 1, ts, sig: sign({ apiKey: API_KEY, ts }) };
  const res = await handleHotRoutes(post("/api/session/heartbeat", body), env(db));
  assert.equal(res.status, 200);
  assert.equal(db.sessions.get(API_KEY).agentOnline, 1);
});

await test("heartbeat: wrong signature → 403 bad-signature", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const ts = Date.now();
  const res = await handleHotRoutes(post("/api/session/heartbeat", { apiKey: API_KEY, online: 1, ts, sig: sign({ apiKey: API_KEY, ts: ts + 1 }) }), env(db));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /bad-signature/);
  assert.equal(db.sessions.get(API_KEY).agentOnline, undefined);
});

await test("heartbeat: missing signature on sealed row → 403 signature-required", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const res = await handleHotRoutes(post("/api/session/heartbeat", { apiKey: API_KEY, online: 1 }), env(db));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /signature-required/);
});

await test("heartbeat: stale ts → 403 stale", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const ts = Date.now() - 10 * 60 * 1000;
  const res = await handleHotRoutes(post("/api/session/heartbeat", { apiKey: API_KEY, online: 1, ts, sig: sign({ apiKey: API_KEY, ts }) }), env(db));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /stale/);
});

await test("heartbeat: invalid apiKey shape → 400 (trust boundary)", async () => {
  const res = await handleHotRoutes(post("/api/session/heartbeat", { apiKey: "sk-bogus", online: 1 }), env(fakeDb()));
  assert.equal(res.status, 400);
});

await test("create: invalid apiKey shape → 400", async () => {
  const res = await handleHotRoutes(post("/api/session/create", { apiKey: "not-a-key" }), env(fakeDb()));
  assert.equal(res.status, 400);
});

await test("create: first registration stores the host key", async () => {
  const db = fakeDb();
  const res = await handleHotRoutes(post("/api/session/create", { apiKey: API_KEY, hostPublicKey: pubRawB64, hostX25519Key: "x25519-pub" }), env(db));
  assert.equal(res.status, 200);
  const row = db.sessions.get(API_KEY);
  assert.equal(row.hostPublicKey, pubRawB64);
  assert.equal(row.hostX25519Key, "x25519-pub");
  assert.equal(row.tunnelUrl, null);
});

await test("create: same key re-sent on restart → kept", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const res = await handleHotRoutes(post("/api/session/create", { apiKey: API_KEY, hostPublicKey: pubRawB64 }), env(db));
  assert.equal(res.status, 200);
  assert.equal(db.sessions.get(API_KEY).hostPublicKey, pubRawB64);
});

await test("create: different key WITHOUT pairing tempKey → stored key wins", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const res = await handleHotRoutes(post("/api/session/create", { apiKey: API_KEY, hostPublicKey: "AAAA" + pubRawB64.slice(4) }), env(db));
  assert.equal(res.status, 200);
  assert.equal(db.sessions.get(API_KEY).hostPublicKey, pubRawB64); // takeover blocked
});

await test("create: different key WITH live tempKey → replaced (reinstall path)", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  db.tempKeys.push({ temp_key: "ABC123", api_key: API_KEY, expires_at: Date.now() + 60000 });
  const res = await handleHotRoutes(post("/api/session/create", { apiKey: API_KEY, hostPublicKey: "BBBB" + pubRawB64.slice(4), tempKey: "abc123" }), env(db));
  assert.equal(res.status, 200);
  assert.equal(db.sessions.get(API_KEY).hostPublicKey, "BBBB" + pubRawB64.slice(4));
});

await test("create: expired tempKey does NOT pair", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  db.tempKeys.push({ temp_key: "ABC123", api_key: API_KEY, expires_at: Date.now() - 1 });
  await handleHotRoutes(post("/api/session/create", { apiKey: API_KEY, hostPublicKey: "CCCC" + pubRawB64.slice(4), tempKey: "ABC123" }), env(db));
  assert.equal(db.sessions.get(API_KEY).hostPublicKey, pubRawB64);
});

await test("update: valid signature → 200, tunnelUrl + CF-Connecting-IP written", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64 });
  const ts = Date.now();
  const fields = { apiKey: API_KEY, tunnelUrl: "https://x.trycloudflare.com", localIp: "192.168.1.5", ts };
  const res = await handleHotRoutes(post("/api/session/update", { ...fields, sig: sign(fields) }, { "CF-Connecting-IP": "1.2.3.4" }), env(db));
  assert.equal(res.status, 200);
  const row = db.sessions.get(API_KEY);
  assert.equal(row.tunnelUrl, "https://x.trycloudflare.com");
  assert.equal(row.localIp, "192.168.1.5");
  assert.equal(row.publicIp, "1.2.3.4");
});

await test("update: wrong signature → 403, tunnelUrl NOT repointed", async () => {
  const db = fakeDb();
  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64, tunnelUrl: "https://legit.trycloudflare.com" });
  const ts = Date.now();
  const fields = { apiKey: API_KEY, tunnelUrl: "https://evil.example", ts };
  const res = await handleHotRoutes(post("/api/session/update", { ...fields, ts, sig: sign({ ...fields, ts: ts + 1 }) }), env(db));
  assert.equal(res.status, 403);
  assert.equal(db.sessions.get(API_KEY).tunnelUrl, "https://legit.trycloudflare.com");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
