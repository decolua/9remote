// Remote Desktop Server Configuration

export const REMOTE_CONFIG = {
  // WebRTC transport config
  // enableWebRTC: true  → init WebRTC manager, handle offer/answer signaling
  // enableTurn: false   → STUN P2P only, skip TURN credential fetch
  webrtc: {
    enableWebRTC: true,
    enableTurn: false,
    turnApiUrl: "https://9remote.cc/api/webrtc/turn-credentials",
    // TTL is 24h, refresh 1h before expiry
    turnRefreshInterval: (24 - 1) * 60 * 60 * 1000,
    // 64KB — SCTP hard limit per message in node-datachannel
    dcMaxMessageSize: 65536,
    // Max buffered bytes before skipping frame — ~1 frame worth at typical quality
    dcBufferThreshold: 65536,
    // DataChannel chunk size (tiles per message) — keep under 64KB
    dcChunkSize: 8,
    // Max tiles per DC frame — split into batches if exceeded
    dcMaxTilesPerFrame: 32,
    // DataChannel reliability mode
    // reliable: false + ordered: false → UDP-like, lowest latency, drop old frames
    dcReliable: true,
    dcOrdered: false,
    // Answer SDP timeout
    answerTimeout: 10000
  },
  // Robot settings
  robotSettings: {
    mouseDelay: 2,
    keyboardDelay: 2
  },

  // Throttling
  throttling: {
    mouseThrottle: 8,
    keyThrottle: 25,
    typeTextThrottle: 100,
    maxTextLength: 1000
  },

  // Resource management
  resourceManagement: {
    inactiveTimeout: 2 * 60 * 1000,
    memoryCheckInterval: 60000,
    memoryWarningThreshold: 1000,
    maxTimersPerClient: 100,
    maxChunkTimersPerClient: 50
  },

  // Streaming - adaptive intervals
  streaming: {
    activeInterval: 60,      // Fast interval when changes detected
    idleInterval: 400,        // Slower interval when idle
    idleThreshold: 3,         // Consecutive no-change frames to switch to idle
    actionCaptureDelay: 50,   // Delay after user action to capture
    chunkSize: 32,
    chunkDelay: 5
  }
};
