// Central tunables and presets for browserUse. No magic values elsewhere.

export const MAX_STEPS_DEFAULT = 24;        // per run chunk (agent resumes for more)
export const MAX_STEPS_HARD = 60;           // absolute per session
export const MAX_MODEL_CALLS = 120;
export const AUTO_CONTINUE_CHUNKS = 2;      // extra resume chunks when expect fails
export const MAX_MS_DEFAULT = 90000;
export const MAX_MS_HARD = 180000;
export const MIN_CONFIDENCE_DEFAULT = 0.55; // below this Jev hands back instead of acting
export const NO_CHANGE_BLOCK = 3;           // consecutive no-change actions -> blocked
export const PLAN_MAX = 3;                  // actions batched per model call (1 primary + 2 planned)
export const SCROLL_BURST_MAX = 30;         // consecutive scrolls in one burst (no model call between)
export const OBSERVE_STALE_RETRIES = 10;
export const BLANK_OBSERVE_MS = 600;        // hydration grace before serving an empty table
export const OBSERVE_SETTLE_RETRIES = 3;    // command-level "did not settle" retries (challenges, churn)
export const OBSERVE_SETTLE_RETRY_MS = 600;
// Adaptive settle (fbu pattern): wait until the page goes quiet, not a fixed frame count.
export const SETTLE_QUIET_MS = 150;         // unchanged-marker window before proceeding
export const SETTLE_POLL_MS = 120;          // marker poll interval — each poll steals page main-thread
export const SETTLE_MIN_FILL_MS = 300;      // after typing — autosuggest debounce
export const FILL_MS_PER_CHAR = 10;         // long pastes keep mutating after insertText
export const FILL_BONUS_MAX_CHARS = 200;    // cap the per-char bonus (2s)
export const SETTLE_MIN_HYDRATE_MS = 500;   // fresh document — DOMContentLoaded can precede hydration
export const SETTLE_MIN_SPA_MS = 1000;      // SPA route change (same document) — views mount late
export const SETTLE_MIN_CLICK_MS = 400;     // clicks — late AJAX content commonly lands ~300ms
export const SETTLE_MIN_LINK_MS = 800;      // link clicks — navigation commit can land late; a
                                            // premature re-observe makes Jev click again (flicker)
export const WAIT_TEXT_TIMEOUT_MS = 6000;   // bounded wait for text/elements to appear
export const WAIT_TEXT_POLL_MS = 200;
export const SETTLE_CAP_MS = 1500;          // hard ceiling per settle
export const NAV_WAIT_COMMIT_MS = 4000;     // main-frame nav: wait the commit past the settle cap
export const SCREENSHOT_QUALITY = 72;
export const SCREENSHOT_FORMAT = "jpeg";
export const STEP_FRAME_QUALITY = 40;     // per-step debug tail — small on purpose
export const STEP_FRAME_SCALE = 0.5;      // CDP clip scale shrinks in-browser, no image lib
export const KEEP_REPORTS = 20;
export const MAX_CHOICES = 255;              // systemone provider hard cap: 256 criteria = HTTP 400
export const MAX_ELEMENTS = 248;            // snapshot budget — leaves room for SKIP/scroll in plan criteria
export const ELEMENT_DEEP_CAP = 1000;       // windowed reads (ls --from) may collect this many before slicing
export const PAGE_TEXT_CAP = 12000;         // full-page text budget (was 6000 viewport-cut)
export const VIEWPORT = { width: 1120, height: 780 };
export const LAUNCH_TIMEOUT_MS = 15000;
export const ATTACH_PROBE_TIMEOUT_MS = 5000; // attach liveness probe ceiling — Chrome's debug WS slows under connect churn
export const CDP_CALL_TIMEOUT_MS = 30000;
export const CONSOLE_BUFFER_MAX = 100;       // console ring — cap-only, never cleared
export const CONSOLE_TEXT_CAP = 200;         // per-line cap (stack traces etc.)
export const CONSOLE_FAIL_TAIL = 5;          // lines riding a failed run/chain response
export const READ_TOTAL_CAP = 200000;        // read renders at most this much to window into
export const OBSERVE_IFRAME_MIN_MS = 800;    // grace floor: GIS frames insert seconds after load
export const OBSERVE_IFRAME_CAP_MS = 2000;   // parent re-quiet when iframes exist (late inserts — GIS)
export const IFRAME_ATTACH_CAP_MS = 2000;    // wait for OOPIF targets to auto-attach
export const IFRAME_FRAME_CAP_MS = 1200;     // per-frame quiet wait — GIS paints buttons AFTER load
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
    models: ["jev-1.13-free"],
    note: "OpenCode free lane · no key · direct call"
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    // OpenRouter "Decisions" family — all speak the same /v1/systemone schema.
    models: [
      "typesafe/jev-1.13",
      "inception/mercury-decide:free"
    ],
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
  mode: "own"         // "own" = engine's isolated Chrome · "attach" = real browser (debug port) · "extension" = real browser (bridge extension)
};

export const ALLOWED_MODES = ["own", "attach", "extension"];

export const KV_KEY = "browserUse.config";
export const ATTACH_GUIDE_URL = "chrome://inspect/#remote-debugging";
export const ATTACH_GUIDE_STEPS = [
  "Open chrome://inspect/#remote-debugging in Chrome (or use the Open button)",
  "Enable \"Allow remote debugging\"",
  "Come back and Check again"
];

// Extension bridge (mode "extension") — same engine, driving pages through a
// content-script runner with synthetic events (no chrome.debugger, no banner).
export const EXT_PROFILE = "__extension__";
export const EXT_RELAY_PATH = "/browser-relay";
export const EXT_HEARTBEAT_MS = 15000; // keeps the MV3 service worker from idling out
export const EXT_PAGE_URL = "chrome://extensions/";
