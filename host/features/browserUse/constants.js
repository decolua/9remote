// Central tunables and presets for browserUse. No magic values elsewhere.

export const MAX_STEPS_DEFAULT = 24;        // per run chunk (agent resumes for more)
export const MAX_STEPS_HARD = 60;           // absolute per session
export const MAX_MODEL_CALLS = 120;
export const AUTO_CONTINUE_CHUNKS = 2;      // extra resume chunks when expect fails
export const MAX_MS_DEFAULT = 90000;
export const MAX_MS_HARD = 180000;
export const MIN_CONFIDENCE_DEFAULT = 0.55; // below this Jev hands back instead of acting
export const NO_CHANGE_BLOCK = 3;           // consecutive no-change actions -> blocked
export const OBSERVE_STALE_RETRIES = 10;
export const BLANK_OBSERVE_MS = 600;        // hydration grace before serving an empty table
// Adaptive settle (fbu pattern): wait until the page goes quiet, not a fixed frame count.
export const SETTLE_QUIET_MS = 150;         // unchanged-marker window before proceeding
export const SETTLE_MIN_FILL_MS = 300;      // after typing — autosuggest debounce
export const SETTLE_MIN_HYDRATE_MS = 500;   // fresh document — DOMContentLoaded can precede hydration
export const SETTLE_MIN_SPA_MS = 1000;      // SPA route change (same document) — views mount late
export const SETTLE_MIN_CLICK_MS = 400;     // clicks — late AJAX content commonly lands ~300ms
export const SETTLE_CAP_MS = 1500;          // hard ceiling per settle
export const SCREENSHOT_QUALITY = 72;
export const SCREENSHOT_FORMAT = "jpeg";
export const KEEP_REPORTS = 20;
export const MAX_ELEMENTS = 250;            // snapshot-side cap, mirrored from upstream port
export const PAGE_TEXT_CAP = 6000;
export const VIEWPORT = { width: 1120, height: 780 };
export const LAUNCH_TIMEOUT_MS = 15000;
export const ATTACH_PROBE_TIMEOUT_MS = 5000; // attach liveness probe ceiling — Chrome's debug WS slows under connect churn
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
export const ATTACH_GUIDE_URL = "chrome://inspect/#remote-debugging";
export const ATTACH_GUIDE_STEPS = [
  "Open chrome://inspect/#remote-debugging in Chrome (or use the Open button)",
  "Enable \"Allow remote debugging\"",
  "Come back and Check again"
];
