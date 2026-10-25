#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connectRelay } from "./connector.js";
const root = resolve(process.env.AREMOTE_HOME || join(homedir(), ".aremote"));
mkdirSync(root, { recursive: true, mode: 0o700 });
const credentialsPath = join(root, "device.json");
const command = process.argv[2] || "start";
function save(data) {
  const tmp = `${credentialsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, credentialsPath);
}
function serverOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("AREMOTE_SERVER_URL must be an HTTP(S) origin");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote servers require HTTPS");
  return url.origin;
}
async function request(server, path, data, token) {
  const response = await fetch(server + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Server request failed"); return result;
}
try {
  if (command === "register") {
    if (existsSync(credentialsPath)) throw new Error("Host is already registered; use rotate or a new AREMOTE_HOME");
    const server = serverOrigin(process.env.AREMOTE_SERVER_URL);
    const device = await request(server, "/api/devices/register", { role: "host", name: process.env.AREMOTE_NAME || hostname(), code: process.env.AREMOTE_PAIRING_CODE, password: process.env.AREMOTE_REGISTRATION_PASSWORD });
    save({ server, ...device }); console.log(`Registered Host ${device.id}. Credentials saved to ${credentialsPath}`);
  } else if (command === "rotate") {
    const stored = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const result = await request(serverOrigin(stored.server), "/api/devices/rotate", {}, stored.token);
    save({ ...stored, token: result.token }); console.log("Credentials rotated. Restart the Host service.");
  } else if (command === "start") {
    const stored = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const server = serverOrigin(process.env.AREMOTE_SERVER_URL || stored.server);
    if (server !== stored.server) throw new Error("Stored credential belongs to another Server; register a separate profile");
    process.env.AREMOTE_SERVER_URL = server;
    process.env.AREMOTE_MANAGED_START = "1";
    process.env.NREMOTE_HOME = root;
    process.env.NREMOTE_PKG = "aremote";
    process.argv = process.argv.slice(0, 2);
    const { loadKey, saveKey } = await import("../cli/utils/state.js");
    const { generateApiKeyV2 } = await import("../cli/utils/apiKey.js");
    if (!loadKey()) saveKey(stored.id, generateApiKeyV2(randomUUID().replaceAll("-", "")));
    const { startServer } = await import("../index.js");
    const local = await startServer(); if (!local.listening) await once(local, "listening");
    const relay = connectRelay({ serverUrl: server, token: stored.token, localPort: local.address().port, onStatus: status => console.log(`ARemote Host: ${status}`) });
    process.once("SIGTERM", () => relay.close()); process.once("SIGINT", () => relay.close());
  } else throw new Error("Usage: node host/aremote/index.js [register|start|rotate]");
} catch (err) { console.error(`ARemote Host: ${err.message}`); process.exitCode = 1; }
