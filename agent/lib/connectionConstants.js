// Connection lifecycle — the layer above transport, below features.
//
// A connection is a DEVICE's presence on this agent, not one socket: carriers
// (tunnel, RTC, anything added later) come and go underneath it. Keeping the
// lifecycle here rather than inside one carrier's socket is what makes every
// protocol equal — the bugs this replaces all came from one carrier owning
// state the other had to reproduce.

export const CONNECTION_STATE = {
  // Proving the KEY. Only auth traffic is carried; nothing else exists yet.
  authenticating: "authenticating",
  // Key proven, waiting for the host to allow this device.
  awaitingHost: "awaitingHost",
  // Both gates passed — features are live.
  active: "active",
  // Refused or torn down. Terminal.
  closed: "closed"
};

// The only events a connection carries before it is active. They are how a device
// stops being unauthenticated, so blocking them would deadlock the handshake.
export const AUTH_EVENTS = new Set([
  "device:tailProof",
  "device:clientReady",
  "disconnect"
]);
