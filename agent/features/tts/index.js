// TTS factory — DRY fallback chain with per-engine token cache & retry cooldown
import * as bing from "./engines/bing.js";
import * as google from "./engines/google.js";
import * as system from "./engines/system.js";
import { filterText } from "./filterText.js";

// Engine format: { audio: base64, format: string }
const FORMAT = {
  bing: "mp3",
  google: "mp3",
  system: process.platform === "darwin" ? "m4a" : "wav",
};

const ENGINES = [bing, google, system];

// Per-engine state: { token, tokenTime, lastError }
const state = {};
for (const e of ENGINES) {
  state[e.name] = { token: null, tokenTime: 0, lastError: 0 };
}

async function getToken(engine) {
  const s = state[engine.name];
  const now = Date.now();

  // Check cooldown after error
  if (s.lastError && engine.retryInterval && now - s.lastError < engine.retryInterval) {
    throw new Error(`${engine.name} in cooldown`);
  }

  // Return cached token if still valid
  if (s.token && engine.refreshInterval && now - s.tokenTime < engine.refreshInterval) {
    return s.token;
  }

  // Fetch new token
  const token = await engine.getToken();
  s.token = token;
  s.tokenTime = now;
  return token;
}

export async function synthesize(rawText, voiceId) {
  const text = filterText(rawText);
  if (!text) throw new Error("TTS text is empty after filtering");

  let lastErr;

  for (const engine of ENGINES) {
    try {
      const token = await getToken(engine);
      const audio = await engine.getAudio(voiceId || engine.defaultVoice, text, token);

      // Reset error state on success
      state[engine.name].lastError = 0;

      // Invalidate token on 429 (already thrown, but reset here for future)
      return { audio, format: FORMAT[engine.name], engine: engine.name };
    } catch (err) {
      console.warn(`[tts] ${engine.name} failed: ${err.message}, trying next...`);
      state[engine.name].lastError = Date.now();
      // Invalidate token on auth/rate errors
      if (err.message.includes("429") || err.message.includes("token")) {
        state[engine.name].token = null;
      }
      lastErr = err;
    }
  }

  throw new Error(`All TTS engines failed: ${lastErr?.message}`);
}

export { ENGINES };

