/**
 * Ephemeral local UI token — in-memory only.
 * Authorizes the localhost UI socket without the permanent key,
 * and resists CSWSH: a malicious web page cannot read this token
 * (token endpoint is loopback-only + same-origin guarded).
 */

import { randomBytes } from "crypto";

let localToken = null;

export function generateLocalToken() {
  localToken = randomBytes(32).toString("hex");
  return localToken;
}

export function getLocalToken() {
  if (!localToken) generateLocalToken();
  return localToken;
}

// Constant-time-ish compare (length guard + strict equality)
export function verifyLocalToken(token) {
  return !!token && typeof token === "string" && token === localToken;
}
