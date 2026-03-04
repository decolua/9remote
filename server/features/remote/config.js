// Remote Desktop Server Configuration

export const remoteConfig = {
  // WebRTC transport config
  // enableWebRTC: true  → init WebRTC manager, handle offer/answer signaling
  // enableTurn: false   → STUN P2P only, skip TURN credential fetch
  webrtc: {
    enableWebRTC: false,
    enableTurn: true,
    turnApiUrl: "https://9remote.cc/api/webrtc/turn-credentials",
    // TTL is 24h, refresh 1h before expiry
    turnRefreshInterval: (24 - 1) * 60 * 60 * 1000,
    // 64KB — SCTP hard limit in node-datachannel
    dcMaxMessageSize: 65536,
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
    activeInterval: 80,      // Fast interval when changes detected
    idleInterval: 400,        // Slower interval when idle
    idleThreshold: 3,         // Consecutive no-change frames to switch to idle
    actionCaptureDelay: 50,   // Delay after user action to capture
    chunkSize: 32,
    chunkDelay: 5
  }
};
