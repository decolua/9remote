// ARemote relay v1; Socket.IO frames remain opaque end to end.
export const PROTOCOL = "aremote.v1";
export const LIMITS = Object.freeze({ frame: 8 * 1024 * 1024, buffered: 16 * 1024 * 1024, sessions: 64, heartbeatMs: 15000, openTimeoutMs: 10000, ticketMs: 30000 });
const ID = /^[a-f0-9-]{36}$/;
export function encodeFrame(sessionId, payload, binary) {
  if (!ID.test(sessionId)) throw new Error("Invalid session ID");
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > LIMITS.frame) throw new Error("Frame too large");
  return Buffer.concat([Buffer.from(binary ? "1" : "0"), Buffer.from(sessionId), body]);
}
export function decodeFrame(raw) {
  const frame = Buffer.from(raw);
  const sessionId = frame.subarray(1, 37).toString();
  if (frame.length < 37 || frame.length > LIMITS.frame + 37 || ![48, 49].includes(frame[0]) || !ID.test(sessionId)) throw new Error("Invalid relay frame");
  return { sessionId, binary: frame[0] === 49, payload: frame.subarray(37) };
}
export function control(raw) {
  if (raw.length > 4096) throw new Error("Control frame too large");
  const msg = JSON.parse(raw.toString());
  if (!msg || !["open", "ready", "close"].includes(msg.type) || !ID.test(msg.sessionId)) throw new Error("Invalid control message");
  if (msg.type === "open" && (typeof msg.clientId !== "string" || !ID.test(msg.clientId))) throw new Error("Invalid client identity");
  return msg;
}
export function send(ws, data, binary = false) {
  if (ws.readyState !== 1 || ws.bufferedAmount + Buffer.byteLength(data) > LIMITS.buffered) return false;
  ws.send(data, { binary });
  return true;
}
