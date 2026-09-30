// Jev decision client — native systemone protocol (state + choice questions in,
// answers with calibrated probabilities out). Presets mirror voice-input config.
import crypto from "node:crypto";
import { readSettings } from "../../lib/settings.js";
import {
  JEV_HTTP_TIMEOUT_MS, JEV_PRESETS, JEV_RETRY_429_MS, OPENCODE_SYSTEMONE_UA
} from "./constants.js";


// Upstream session-id shapes: ses_/msg_ + 12 hex + 14 base62 (same recipe as opencodeStt).
function opencodeId(prefix) {
  const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = Array.from(crypto.randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}${random}`;
}

// Resolve user config into a concrete {url, model, headers} for one request.
export function resolveJevConfig(config = {}) {
  const preset = JEV_PRESETS[config.preset] || JEV_PRESETS.free;
  const endpoint = (config.endpoint || preset.endpoint || "").trim();
  const model = (config.model || preset.model || "").trim();
  if (!endpoint) return { error: "No systemone endpoint configured" };
  if (!model) return { error: "No model configured" };
  const url = endpoint.endsWith("/systemone") ? endpoint : `${endpoint.replace(/\/$/, "")}/systemone`;
  const headers = { "Content-Type": "application/json" };
  if (config.preset === "free" || endpoint.includes("opencode.ai")) {
    // Free lane gate: look like the opencode desktop client (recipe verified live).
    Object.assign(headers, {
      "Authorization": "Bearer public",
      "User-Agent": OPENCODE_SYSTEMONE_UA,
      "x-opencode-client": "desktop",
      "x-opencode-session": opencodeId("ses"),
      "x-opencode-request": opencodeId("msg"),
      "x-opencode-project": "global"
    });
  } else if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  } else if (readSettings().voiceConfig?.openrouterKey) {
    // One paste for both features: fall back to the voice-input OpenRouter key.
    headers["Authorization"] = `Bearer ${readSettings().voiceConfig.openrouterKey}`;
  } else if (endpoint.includes("openrouter.ai")) {
    // Calling OpenRouter without auth yields a cryptic "No cookie auth
    // credentials found" — fail here with an actionable message instead.
    return { error: "OpenRouter preset needs an API key — set it in settings" };
  }
  return { url, model, headers };
}

// Upstream contract: probabilities cover exactly the offered ids, sum to ~1 and the
// choice is the max — anything else is refused before any action runs.
export function validateChoice(answer, ids) {
  try {
    const probabilities = answer.probabilities;
    const numbers = [...Object.values(probabilities), answer.confidence];
    const sameKeySet = Object.keys(probabilities).length === ids.length &&
      ids.every((id) => id in probabilities);
    const valid =
      ids.includes(answer.choice) &&
      sameKeySet &&
      numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) < 0.02 &&
      probabilities[answer.choice] >= Math.max(...Object.values(probabilities)) - 1e-6;
    return valid ? answer : null;
  } catch {
    return null;
  }
}

async function postJson(url, headers, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JEV_HTTP_TIMEOUT_MS)
      });
    } catch (e) {
      throw new Error(`Jev connection failed: ${e.message}`);
    }
    if ([429, 503, 529].includes(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, JEV_RETRY_429_MS * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        detail = data?.error?.message || data?.message || detail;
      } catch { /* keep status-line detail */ }
      throw new Error(`Jev provider error: ${detail}`);
    }
    return await res.json();
  }
  throw new Error("Jev provider unavailable");
}

// One decision: {state, questions} -> validated answers keyed by question name.
export async function decide({ state, questions }, config) {
  const resolved = resolveJevConfig(config);
  if (resolved.error) throw new Error(resolved.error);
  const result = await postJson(resolved.url, resolved.headers, { model: resolved.model, state, questions });
  const answers = result?.answers;
  if (!answers || typeof answers !== "object") throw new Error("Jev returned no answers");
  return { answers, model: result.model || resolved.model, usage: result.usage || {} };
}

// Settings "Test" button: one tiny choice call, no browser involved.
export async function testConfig(config) {
  const started = Date.now();
  const result = await decide({
    state: { page: { url: "https://example.com", title: "Test", text: "test" }, elements: [], recent_actions: [] },
    questions: {
      operation: {
        type: "choice",
        criteria: { DONE: "Nothing to do", BLOCKED: "Cannot progress" },
        instructions: { goal: "connectivity test", rules: "pick one" }
      }
    }
  }, config);
  const answer = validateChoice(result.answers.operation, ["DONE", "BLOCKED"]);
  if (!answer) throw new Error("Jev response failed validation");
  return { ok: true, model: result.model, choice: answer.choice, latencyMs: Date.now() - started };
}
