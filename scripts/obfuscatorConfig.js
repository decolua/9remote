/**
 * Centralized obfuscator presets.
 * - nodePreset: for Node.js CJS bundles (agent cli/server/daemon).
 * - browserPreset: lighter preset for browser bundles (Vite/Next client).
 */

// Medium preset: balance between protection and runtime performance.
// Avoid selfDefending/debugProtection to keep compatibility across runtimes.
export const nodePreset = {
  compact: true,
  simplify: true,
  target: "node",
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// Lighter preset for browser: avoid heavy transforms that slow UI.
export const browserPreset = {
  compact: true,
  simplify: true,
  target: "browser",
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.6,
  splitStrings: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  numbersToExpressions: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};
