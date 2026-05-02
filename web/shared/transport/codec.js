// Wire codec for non-socket.io adapters (RTC, future QUIC).
// Envelope shape: {event, args, ackId?}
// Buffer/Uint8Array → {__b: base64} on wire (browser uses Uint8Array natively).

function replacer(_key, value) {
  if (value instanceof Uint8Array) {
    let bin = "";
    for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i]);
    return { __b: btoa(bin) };
  }
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === "object" && typeof value.__b === "string") {
    const bin = atob(value.__b);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return value;
}

export function encode(envelope) {
  return JSON.stringify(envelope, replacer);
}

export function decode(wire) {
  return JSON.parse(typeof wire === "string" ? wire : new TextDecoder().decode(wire), reviver);
}
