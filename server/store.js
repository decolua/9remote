import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, secret, passwordHash } from "./auth.js";
export async function openStore(path, adminPassword, registrationPassword) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('host','client')), name TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastSeen INTEGER);
    CREATE TABLE IF NOT EXISTS grants (clientId TEXT NOT NULL REFERENCES devices(id), hostId TEXT NOT NULL REFERENCES devices(id), PRIMARY KEY(clientId,hostId));
    CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, role TEXT NOT NULL, expiresAt INTEGER NOT NULL, hostIds TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, event TEXT NOT NULL, deviceId TEXT, sessionId TEXT);
    CREATE TABLE IF NOT EXISTS traffic (id INTEGER PRIMARY KEY CHECK(id=1), upload INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO traffic(id) VALUES(1);`);
  const getSetting = (key) => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
  const setSetting = (key, value) => db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  if (!getSetting("adminHash")) setSetting("adminHash", await passwordHash(adminPassword));
  if (registrationPassword && !getSetting("registrationHash")) setSetting("registrationHash", await passwordHash(registrationPassword));
  return {
    db, getSetting, setSetting,
    log(event, deviceId = null, sessionId = null) {
      db.prepare("INSERT INTO log(time,event,deviceId,sessionId) VALUES(?,?,?,?)").run(Date.now(), event, deviceId, sessionId);
      db.prepare("DELETE FROM log WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM log)").run();
    },
    device(token) { return token ? db.prepare("SELECT * FROM devices WHERE tokenHash=? AND revoked=0").get(digest(token)) : null; },
    createDevice(role, name) {
      const id = randomUUID(), token = secret();
      db.prepare("INSERT INTO devices(id,role,name,tokenHash,createdAt) VALUES(?,?,?,?,?)").run(id, role, name, digest(token), Date.now());
      return { id, role, name, token };
    },
    allowed(clientId, hostId) {
      return !!db.prepare("SELECT 1 FROM grants g JOIN devices c ON c.id=g.clientId JOIN devices h ON h.id=g.hostId WHERE g.clientId=? AND g.hostId=? AND c.revoked=0 AND h.revoked=0 AND c.role='client' AND h.role='host'").get(clientId, hostId);
    },
    seen(id) { db.prepare("UPDATE devices SET lastSeen=? WHERE id=?").run(Date.now(), id); },
    traffic(upload, download) { db.prepare("UPDATE traffic SET upload=upload+?,download=download+? WHERE id=1").run(upload, download); }
  };
}
