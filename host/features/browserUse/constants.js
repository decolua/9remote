// Central tunables and presets for browserUse. No magic values elsewhere.

export const MAX_STEPS_DEFAULT = 12;        // per run chunk (agent resumes for more)
export const MAX_STEPS_HARD = 60;           // absolute per session
export const MAX_MODEL_CALLS = 120;
export const MAX_MS_DEFAULT = 45000;
export const MAX_MS_HARD = 180000;
export const MIN_CONFIDENCE_DEFAULT = 0.55; // below this Jev hands back instead of acting
export const NO_CHANGE_BLOCK = 3;           // consecutive no-change actions -> blocked
export const OBSERVE_STALE_RETRIES = 10;
export const WAIT_COMBOBOX_MS = 200;        // cap while waiting for autocomplete options
export const WAIT_OTHER_MS = 50;
export const WAIT_FRAMES = 2;
export const SCREENSHOT_QUALITY = 72;
export const SCREENSHOT_FORMAT = "jpeg";
export const KEEP_REPORTS = 20;
export const MAX_ELEMENTS = 250;            // snapshot-side cap, mirrored from upstream port
export const PAGE_TEXT_CAP = 6000;
export const VIEWPORT = { width: 1120, height: 780 };
export const LAUNCH_TIMEOUT_MS = 15000;
export const CDP_CALL_TIMEOUT_MS = 30000;
export const JEV_HTTP_TIMEOUT_MS = 25000;
export const JEV_RETRY_429_MS = 500;
export const FREE_PORT_HINT = 0;            // listen(0) to reserve a free port

// Jev decision presets. Mirrors the voice-input preset pattern (voiceStt.js):
// a preset fills endpoint+model; only keys are user input.
export const OPENCODE_SYSTEMONE_UA = "opencode/1.18.31";
export const JEV_PRESETS = {
  free: {
    label: "Free",
    endpoint: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13-free",
    note: "OpenCode free lane · no key · direct call"
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    note: "Needs OpenRouter key"
  },
  custom: { label: "Custom", endpoint: "", model: "", note: "Any systemone-compatible endpoint" }
};

export const JEV_CONFIG_DEFAULTS = {
  enabled: false,
  preset: "free",
  endpoint: "",   // override; empty = preset default
  model: "",      // override; empty = preset default
  apiKey: "",     // free lane ignores this
  minConfidence: MIN_CONFIDENCE_DEFAULT,
  headless: true,     // own-profile Chrome runs headless unless disabled
  mode: "own"         // "own" = engine's isolated Chrome · "attach" = user's real browser (debug)
};

export const KV_KEY = "browserUse.config";
export const ATTACH_GUIDE_STEPS = [
  "Mở Chrome, gõ địa chỉ chrome://inspect/#remote-debugging",
  "Bật toggle \"Allow remote debugging\"",
  "Quay lại đây và bấm kiểm tra lại"
];
