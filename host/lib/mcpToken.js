/**
 * Persistent MCP bearer token.
 * Unlike the ephemeral localToken, this one survives restarts: it is written into
 * the AI CLIs' own config files when their hook is enabled, so it cannot change
 * every boot. Loopback-only routing still guards the endpoint; the token stops
 * another local process from driving the panel.
 */

import fs from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { PATHS } from "./constants.js";

const TOKEN_FILE = path.join(PATHS.STATE, "mcpToken");
let cached = null;

export function getMcpToken() {
  if (cached) return cached;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return (cached = saved);
  } catch {}
  cached = randomBytes(32).toString("hex");
  fs.mkdirSync(PATHS.STATE, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, cached, { mode: 0o600 });
  return cached;
}

export function verifyMcpToken(header) {
  const token = String(header || "").replace(/^Bearer\s+/i, "");
  const expected = getMcpToken();
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
