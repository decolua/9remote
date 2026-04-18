/**
 * Centralized obfuscator presets.
 * Prioritize runtime performance: obfuscate identifiers + strings only.
 * Avoid controlFlowFlattening/deadCodeInjection/transformObjectKeys which
 * add significant runtime overhead. String array is decoded once at startup.
 */

const basePreset = {
  compact: true,
  simplify: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
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

export const nodePreset = {
  ...basePreset,
  target: "node",
};

export const browserPreset = {
  ...basePreset,
  target: "browser",
};
