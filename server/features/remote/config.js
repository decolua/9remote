// Remote Desktop Server Configuration

export const remoteConfig = {
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
    activeInterval: 100,      // Fast interval when changes detected
    idleInterval: 400,        // Slower interval when idle
    idleThreshold: 3,         // Consecutive no-change frames to switch to idle
    actionCaptureDelay: 50,   // Delay after user action to capture
    chunkSize: 32,
    chunkDelay: 5
  }
};
