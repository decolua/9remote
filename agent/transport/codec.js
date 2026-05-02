// Wire codec for non-socket.io adapters (RTC, future QUIC).
// Envelope: {event, args, ackId?}. Node uses Buffer (toJSON → {type:"Buffer", data:[]}).

function replacer(_key, value) {
  if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
    return { __b: Buffer.from(value.data).toString("base64") };
  }
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.__b === "string") {
    return Buffer.from(value.__b, "base64");
  }
  return value;
}

export function encode(envelope) {
  return JSON.stringify(envelope, replacer);
}

export function decode(wire) {
  return JSON.parse(typeof wire === "string" ? wire : Buffer.from(wire).toString("utf8"), reviver);
}
