// Anti-detection for automated Chrome. Rule: a spoof may only make the browser
// look MORE like real Chrome — never ADD anything a genuine build lacks. Added
// APIs, own-instance properties and non-native function sources are all
// deployed detector checks. Headless=new already matches headful on plugins,
// notifications and UA-CH brands, so the script stays minimal.
const GPU_RENDERERS = {
  darwin: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
  win32: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  default: "ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.8)"
};
const FAKE_GPU_RENDERER = GPU_RENDERERS[process.platform] || GPU_RENDERERS.default;

export const ANTI_DETECTION_SCRIPT = `(function() {
  // WebGL: install the swap ONLY when this machine really rasterizes in
  // software (GPU-less host). On real GPUs even a wrapped getParameter is a
  // toString() tell, so the prototype must stay 100% native there.
  try {
    var GPU_RENDERER = ${JSON.stringify(FAKE_GPU_RENDERER)};
    var probe = document.createElement("canvas").getContext("webgl");
    var ext = probe && probe.getExtension("WEBGL_debug_renderer_info");
    var real = ext ? probe.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
    if (typeof real === "string" && /SwiftShader|Software Adaptor|llvmpipe/i.test(real)) {
      // Real vendor strings carry the ANGLE backend suffix: "Google Inc. (Apple)".
      var backend = (/ANGLE \\(([^,]+)/.exec(GPU_RENDERER) || [])[1] || "Intel";
      var patch = function(proto) {
        if (!proto || proto.getParameter.__antiPatch) return;
        var orig = proto.getParameter;
        proto.getParameter = function(param) {
          var val = orig.call(this, param);
          if (typeof val === "string" && /SwiftShader|Software Adaptor|llvmpipe/i.test(val)) {
            if (param === 37446) return GPU_RENDERER;
            if (param === 37445) return "Google Inc. (" + backend + ")";
          }
          return val;
        };
        proto.getParameter.__antiPatch = true;
      };
      if (window.WebGLRenderingContext) patch(window.WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patch(window.WebGL2RenderingContext.prototype);
    }
  } catch {}
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  }
})()`;

export function stripHeadlessUa(ua) {
  return String(ua || "").replace(/HeadlessChrome/gi, "Chrome");
}

const HIGH_ENTROPY_FIELDS = ["brands", "fullVersionList", "mobile", "platform", "platformVersion", "architecture", "bitness", "model"];

// Read the browser's own UA string + high-entropy hints from a session. Polls
// inside the page: a synthetic about:blank target exposes no userAgentData at
// all, so callers use a real page's session and cache the result.
export async function readUserAgentIdentity(client, sessionId) {
  try {
    const res = await client.call("Runtime.evaluate", {
      expression: `(async () => {
        for (let i = 0; i < 40; i++) {
          if (navigator.userAgentData) {
            return { userAgent: navigator.userAgent, hints: await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY_FIELDS)}) };
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    return res?.result?.value || null;
  } catch { return null; }
}

// setUserAgentOverride params stripping ONLY the Headless token. Hand-built
// brand lists lack the mandatory grease brand (e.g. "Not(A:Brand") and get the
// whole call rejected by CDP with "Invalid parameters" — copy the browser's
// own hints instead. Null when there is nothing to strip.
export function headlessOverride(identity) {
  if (!identity?.userAgent || !/HeadlessChrome/i.test(identity.userAgent)) return null;
  const params = { userAgent: stripHeadlessUa(identity.userAgent) };
  const hints = identity.hints;
  if (hints?.brands?.length) {
    const full = (hints.fullVersionList || []).find((b) => /Google Chrome/i.test(b.brand));
    params.userAgentMetadata = {
      // Older headless builds brand themselves "Headless Chromium" — retag.
      brands: hints.brands.map((b) => (/headless/i.test(b.brand) ? { ...b, brand: "Google Chrome" } : b)),
      fullVersionList: hints.fullVersionList,
      fullVersion: full?.version || (/Chrome\/([\d.]+)/.exec(identity.userAgent) || [])[1],
      mobile: hints.mobile,
      platform: hints.platform,
      platformVersion: hints.platformVersion,
      architecture: hints.architecture,
      bitness: hints.bitness,
      model: hints.model || ""
    };
  }
  return params;
}
