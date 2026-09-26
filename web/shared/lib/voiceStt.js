// Voice STT via an OpenAI-compatible chat endpoint (default OpenRouter).
// Shared by the settings modal (test buttons) and the AI dictation engine.
import { useConnectionStore } from "@/shared/stores/connectionStore";

export const VOICE_ENDPOINT_DEFAULT = "https://openrouter.ai/api/v1";
export const VOICE_LS_KEYS = {
  enabled: "voiceEnabled", mode: "voiceMode",
  // legacy flat config, read once for migration
  endpoint: "voiceEndpoint", apiKey: "voiceApiKey", model: "voiceModel",
  preset: "voicePreset", geminiKeys: "voiceGeminiKeys", openrouterKey: "voiceOpenrouterKey",
  customEndpoint: "voiceCustomEndpoint", customModel: "voiceCustomModel", customKey: "voiceCustomKey",
  opencodeModel: "voiceOpencodeModel",
};

// Presets fill endpoint + model; only the key(s) are user input.
export const VOICE_PRESETS = {
  gemini: {
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite",
    note: "Free tier · quota per project (AI Studio)",
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: VOICE_ENDPOINT_DEFAULT,
    model: "google/gemini-3.5-flash-lite",
    note: "$0.30/1M in · $2.50/1M out",
  },
  // Free tier via the agent — opencode.ai has no CORS, so the browser cannot call it
  opencode: {
    label: "Free",
    endpoint: "https://opencode.ai/zen/v1",
    model: "mimo-v2.6-flash-free",
    note: "OpenCode free · no key · routed through the agent",
  },
  custom: { label: "Custom" },
};
const REQUEST_TIMEOUT_MS = 15000;
// Agent-side STT gets the upstream's full window — long dictation clips outrun 15s.
const AGENT_STT_TIMEOUT_MS = 60000;
const RECORD_MS = 3000;

// ponytail: /models can't validate keys on OpenRouter (public route), so a
// 1-token completion is the cheapest portable check of the key + model pair.
export async function chat(cfg, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (!cfg.apiKey?.trim()) throw new Error("No API key set");
    const base = (cfg.endpoint?.trim() || VOICE_ENDPOINT_DEFAULT).replace(/\/+$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ stream: false, ...body }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

export const sttErrText = (err) =>
  err?.name === "AbortError" ? "Timed out" :
  err?.message === "Failed to fetch" ? "Network/CORS error" :
  err?.message || "Failed";

// Fixed-length clip for the test button; dictation manages its own recorder.
export async function recordClip(ms = RECORD_MS) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: rec.mimeType || "audio/webm" });
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.readAsDataURL(blob);
  });
}

// Browsers record webm/opus (mp4/aac on Safari), but Gemini's OpenAI layer
// only accepts wav/mp3 — decode the clip and send a 16 kHz mono WAV, which
// every endpoint takes. ~32 KB/s, so dictation clips stay small.
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function blobToWav(blob) {
  const RATE = 16000;
  const dec = new OfflineAudioContext(1, 1, RATE);
  const audio = await dec.decodeAudioData(await blob.arrayBuffer());
  const out = new OfflineAudioContext(1, Math.ceil(audio.duration * RATE), RATE);
  const src = out.createBufferSource();
  src.buffer = audio;
  src.connect(out.destination);
  src.start();
  return encodeWav((await out.startRendering()).getChannelData(0), RATE);
}

// Map the store state to the endpoint/model/key the request actually uses.
// Gemini rotates across its key list — N free keys stack to N x free quota.
let rrIdx = 0;
export function resolveVoiceCfg(s) {
  if (s.preset === "opencode") {
    return { endpoint: VOICE_PRESETS.opencode.endpoint, model: s.opencodeModel?.trim() || VOICE_PRESETS.opencode.model, apiKey: "public" };
  }
  if (s.preset === "gemini" || s.preset === "openrouter") {
    const p = VOICE_PRESETS[s.preset];
    const model = s[`${s.preset}Model`]?.trim() || p.model;
    if (s.preset === "gemini") {
      const keys = s.geminiKeys.map((k) => k.trim()).filter(Boolean);
      return { endpoint: p.endpoint, model, apiKey: keys.length ? keys[rrIdx++ % keys.length] : "" };
    }
    return { endpoint: p.endpoint, model, apiKey: s.openrouterKey };
  }
  return { endpoint: s.customEndpoint, model: s.customModel, apiKey: s.customKey };
}

const STT_PROMPT = `Transcribe this audio accurately for a developer coding & terminal context.
- Auto-detect spoken language; do NOT translate.
- Keep English tech terms, code, and CLI commands in English (e.g. git, npm, docker, API, bug, log, deploy).
- Add natural punctuation. Omit filler sounds.
- Output ONLY the transcribed text.`;

// Free preset: the agent does the upstream call (opencode.ai blocks browser CORS).
function transcribeViaAgent(model, wavB64) {
  return new Promise((resolve, reject) => {
    const bus = useConnectionStore.getState().bus;
    if (!bus || typeof bus.emit !== "function") return reject(new Error("No agent connection"));
    const timer = setTimeout(() => reject(new Error("Timed out")), AGENT_STT_TIMEOUT_MS);
    bus.emit("voice:transcribe", { wavB64, model, prompt: STT_PROMPT }, (res) => {
      clearTimeout(timer);
      if (res?.error) reject(new Error(res.error));
      else resolve(res?.text || "");
    });
  });
}

export async function transcribeBlob(state, blob) {
  const cfg = resolveVoiceCfg(state);
  const wavB64 = await blobToBase64(await blobToWav(blob));
  if (state.preset === "opencode") return transcribeViaAgent(cfg.model, wavB64);
  const data = await chat(cfg, {
    model: cfg.model,
    messages: [{ role: "user", content: [
      { type: "text", text: STT_PROMPT },
      { type: "input_audio", input_audio: { data: wavB64, format: "wav" } },
    ]}],
  });
  return data?.choices?.[0]?.message?.content?.trim() || "";
}
