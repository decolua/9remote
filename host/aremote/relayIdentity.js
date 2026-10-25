import { randomBytes } from "node:crypto";
const sessions = new Map();
export function issueRelayIdentity(clientId, sessionId) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { clientId, sessionId }); return token;
}
export function relayIdentity(token) { return typeof token === "string" ? sessions.get(token) : undefined; }
export function removeRelayIdentity(token) { sessions.delete(token); }
