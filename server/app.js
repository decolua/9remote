import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { isIP } from "node:net";
import { passwordHash, verifyPassword, digest, secret, bearer } from "./auth.js";
import { openStore } from "./store.js";
import { attachRelay } from "./relay.js";
import { LIMITS } from "../shared/relay/protocol.js";
const publicDir = new URL("./public/", import.meta.url);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/x-component" };
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) fail(413, "Request too large"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid JSON"); return value; }
  catch { fail(400, "Invalid JSON"); }
}
export async function createApp(config = {}) {
  const store = await openStore(config.dbPath || ":memory:", config.adminPassword, config.registrationPassword);
  const admins = new Map(), tickets = new Map(), attempts = new Map();
  const origins = new Set(config.origins || []);
  function limited(req) {
    const forwarded = config.trustProxy && req.headers["x-forwarded-for"]?.split(",").at(-1).trim();
    const ip = forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
    const key = `${ip}:${new URL(req.url, "http://localhost").pathname}`;
    const now = Date.now();
    for (const [ip, row] of attempts) if (row.until < now) attempts.delete(ip);
    let row = attempts.get(key);
    if (!row) { if (attempts.size >= 10000) fail(429, "Try again later"); attempts.set(key, row = { n: 0, until: now + 60000 }); }
    if (++row.n > 20) fail(429, "Try again later");
  }
  function admin(req) {
    const hash = digest(bearer(req));
    if ((admins.get(hash) || 0) < Date.now()) { admins.delete(hash); fail(401, "Admin login required"); }
  }
  function device(req, role) {
    const d = store.device(bearer(req));
    if (!d || (role && d.role !== role)) fail(401, "Device authentication required");
    return d;
  }
  const http = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      const origin = req.headers.origin;
      const sameOrigin = origin && (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (origin && !sameOrigin && !origins.has(origin)) fail(403, "Origin not allowed");
      if (origin && (sameOrigin || origins.has(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") return json({ ok: true, protocol: "aremote.v1" });
      if (path === "/api/admin/login" && req.method === "POST") {
        limited(req); const input = await body(req);
        if (!await verifyPassword(input.password, store.getSetting("adminHash"))) { store.log("admin-login-failed"); fail(401, "Invalid credentials"); }
        for (const [key, expiry] of admins) if (expiry < Date.now()) admins.delete(key);
        if (admins.size >= 100) fail(429, "Too many admin sessions");
        const token = secret(); admins.set(digest(token), Date.now() + 3600000); store.log("admin-login");
        return json({ token, expiresIn: 3600 });
      }
      if (path.startsWith("/api/admin/")) {
        admin(req);
        if (path === "/api/admin/logout" && req.method === "POST") { admins.delete(digest(bearer(req))); return json({ ok: true }); }
        if (path === "/api/admin/password" && req.method === "POST") {
          limited(req); const input = await body(req);
          if (!await verifyPassword(input.currentPassword, store.getSetting("adminHash"))) fail(401, "Invalid credentials");
          const hash = await passwordHash(input.password).catch(() => fail(400, "Password must contain 12–1024 characters"));
          store.setSetting("adminHash", hash); admins.clear(); store.log("admin-password-changed"); return json({ ok: true });
        }
        if (path === "/api/admin/status" && req.method === "GET") {
          const devices = store.db.prepare("SELECT id,role,name,revoked,createdAt,lastSeen FROM devices ORDER BY createdAt DESC").all().map(d => ({ ...d, online: relay.online(d.id) }));
          return json({ devices, sessions: [...relay.sessions].map(([id, s]) => ({ id, hostId: s.hostId, clientId: s.clientId, createdAt: s.createdAt })), traffic: store.db.prepare("SELECT upload,download,upload+download AS total FROM traffic").get(), grants: store.db.prepare("SELECT * FROM grants").all() });
        }
        if (path === "/api/admin/logs" && req.method === "GET") return json(store.db.prepare("SELECT * FROM log ORDER BY id DESC LIMIT 200").all());
        if (path === "/api/admin/pairings" && req.method === "POST") {
          const { role, hostIds = [] } = await body(req);
          if (!["host", "client"].includes(role) || !Array.isArray(hostIds) || hostIds.length > 100 || (role === "host" && hostIds.length)) fail(400, "Invalid pairing");
          for (const id of hostIds) if (typeof id !== "string" || !store.db.prepare("SELECT 1 FROM devices WHERE id=? AND role='host' AND revoked=0").get(id)) fail(400, "Invalid host");
          store.db.prepare("DELETE FROM pairings WHERE expiresAt < ?").run(Date.now());
          if (store.db.prepare("SELECT count(*) AS n FROM pairings").get().n >= 1000) fail(429, "Too many pairings");
          const code = secret(), expiresAt = Date.now() + 600000;
          store.db.prepare("INSERT INTO pairings VALUES(?,?,?,?)").run(digest(code), role, expiresAt, JSON.stringify(hostIds));
          store.log("pairing-created"); return json({ code, expiresAt });
        }
        if (path === "/api/admin/grants" && ["POST", "DELETE"].includes(req.method)) {
          const { clientId, hostId } = await body(req);
          if (typeof clientId !== "string" || typeof hostId !== "string" || !store.db.prepare("SELECT 1 FROM devices WHERE id=? AND role='client' AND revoked=0").get(clientId) || !store.db.prepare("SELECT 1 FROM devices WHERE id=? AND role='host' AND revoked=0").get(hostId)) fail(400, "Invalid grant");
          if (req.method === "POST") store.db.prepare("INSERT OR IGNORE INTO grants VALUES(?,?)").run(clientId, hostId);
          else { store.db.prepare("DELETE FROM grants WHERE clientId=? AND hostId=?").run(clientId, hostId); relay.revokeGrant(clientId, hostId); }
          store.log(req.method === "POST" ? "access-granted" : "access-revoked", clientId); return json({ ok: true });
        }
        if (path === "/api/admin/revoke" && req.method === "POST") {
          const { id } = await body(req); if (typeof id !== "string") fail(400, "Invalid device");
          store.db.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(id); relay.dropDevice(id); store.log("device-revoked", id); return json({ ok: true });
        }
        fail(404, "Not found");
      }
      if (path === "/api/devices/register" && req.method === "POST") {
        limited(req); const { role, name, password, code } = await body(req);
        if (!["host", "client"].includes(role) || typeof name !== "string" || !name.trim() || name.length > 100) fail(400, "Invalid device");
        let pairing;
        if (typeof code === "string") pairing = store.db.prepare("SELECT * FROM pairings WHERE hash=? AND role=? AND expiresAt>?").get(digest(code), role, Date.now());
        if (!pairing && !await verifyPassword(password, store.getSetting("registrationHash"))) fail(401, "Invalid registration credentials");
        store.db.exec("BEGIN IMMEDIATE");
        let created;
        try {
          if (pairing) {
            const deleted = store.db.prepare("DELETE FROM pairings WHERE hash=? AND expiresAt>?").run(pairing.hash, Date.now());
            if (!deleted.changes) fail(401, "Pairing expired or consumed");
          }
          created = store.createDevice(role, name.trim());
          if (pairing) for (const hostId of JSON.parse(pairing.hostIds)) store.db.prepare("INSERT INTO grants VALUES(?,?)").run(created.id, hostId);
          store.db.exec("COMMIT");
        } catch (err) { store.db.exec("ROLLBACK"); throw err; }
        store.log("device-registered", created.id); return json(created, 201);
      }
      if (path === "/api/devices/rotate" && req.method === "POST") {
        const d = device(req), token = secret();
        store.db.prepare("UPDATE devices SET tokenHash=? WHERE id=?").run(digest(token), d.id);
        relay.dropDevice(d.id); store.log("device-rotated", d.id); return json({ token });
      }
      if (path === "/api/hosts" && req.method === "GET") {
        const d = device(req, "client"); store.seen(d.id);
        const hosts = store.db.prepare("SELECT h.id,h.name,h.lastSeen FROM grants g JOIN devices h ON h.id=g.hostId WHERE g.clientId=? AND h.revoked=0").all(d.id);
        return json({ hosts: hosts.map(h => ({ ...h, online: relay.hosts.has(h.id) })) });
      }
      if (path === "/api/tickets" && req.method === "POST") {
        const d = device(req, "client"), { hostId } = await body(req);
        if (typeof hostId !== "string" || !store.allowed(d.id, hostId)) fail(403, "Host access denied");
        if (!relay.hosts.has(hostId)) fail(503, "Host offline");
        if (tickets.size >= 4096) fail(429, "Too many pending connections");
        const ticket = secret(); tickets.set(ticket, { clientId: d.id, hostId, expiresAt: Date.now() + LIMITS.ticketMs });
        return json({ ticket, expiresIn: LIMITS.ticketMs / 1000 });
      }
      if (req.method === "GET" && (path === "/admin" || path === "/admin.js" || path === "/admin.css")) {
        const file = path === "/admin" ? "admin.html" : path.slice(1);
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.writeHead(200, { "Content-Type": MIME[extname(file)] }); return res.end(readFileSync(new URL(file, publicDir)));
      }
      if (config.webDir && req.method === "GET" && !path.startsWith("/api/")) {
        let decoded;
        try { decoded = decodeURIComponent(path); } catch { fail(400, "Bad path"); }
        if (["/admin", "/download"].some(prefix => decoded === prefix || decoded.startsWith(prefix + "/") || decoded === prefix + ".html" || decoded === prefix + ".txt")) fail(404, "Not found");
        const terminal = /^\/workspace\/terminal\/([^/]+)\/?$/.exec(decoded);
        if (terminal && !["default", "default.html", "default.txt"].includes(terminal[1]) && !terminal[1].endsWith(".txt")) {
          const query = new URL(req.url, "http://localhost").searchParams;
          query.set("session", terminal[1].replace(/\.html$/, ""));
          res.writeHead(302, { Location: `/workspace/terminal/default?${query}` });
          return res.end();
        }
        const root = resolve(config.webDir);
        const base = resolve(root, `.${decoded === "/" ? "/login" : decoded}`);
        if (base.startsWith(root + "/")) for (const file of [base, base + ".html", base + "/index.html"]) {
          if (existsSync(file) && statSync(file).isFile()) { res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" }); return res.end(readFileSync(file)); }
        }
      }
      fail(404, "Not found");
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      json({ error: err.status ? err.message : "Internal server error" }, err.status || 500);
      if (!err.status) store.log("request-error");
    }
  });
  http.requestTimeout = 15000; http.headersTimeout = 10000;
  const relay = attachRelay(http, store, tickets, config);
  return { http, store, relay, async close() { await relay.close(); http.closeAllConnections(); await new Promise(r => http.close(r)); store.db.close(); } };
}
