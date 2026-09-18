// Voice STT via an OpenAI-compatible chat endpoint (default OpenRouter).
// Shared by the settings modal (test buttons) and the AI dictation engine.
export const VOICE_ENDPOINT_DEFAULT = "https://openrouter.ai/api/v1";
export const VOICE_LS_KEYS = {
  enabled: "voiceEnabled", mode: "voiceMode", endpoint: "voiceEndpoint",
  apiKey: "voiceApiKey", model: "voiceModel",
};
const REQUEST_TIMEOUT_MS = 15000;
const RECORD_MS = 3000;

// ponytail: /models can't validate keys on OpenRouter (public route), so a
// 1-token completion is the cheapest portable check of the key + model pair.
export async function chat(cfg, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const base = (cfg.endpoint?.trim() || VOICE_ENDPOINT_DEFAULT).replace(/\/+$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
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

// ponytail: input_audio officially lists wav/mp3; browser records webm/opus
// (mp4/aac on Safari). Works with audio-input models that accept the blob's
// native format; transcode later if a provider rejects it.
function audioFormat(mimeType) {
  if (mimeType?.includes("mp4")) return "mp4";
  if (mimeType?.includes("ogg")) return "ogg";
  return "webm";
}

export async function transcribeBlob(cfg, blob, lang) {
  const data = await chat(cfg, {
    model: cfg.model,
    messages: [{ role: "user", content: [
      { type: "text", text: `Transcribe this audio${lang ? ` (${lang})` : ""}. Reply with the transcript text only.` },
      { type: "input_audio", input_audio: { data: await blobToBase64(blob), format: audioFormat(blob.type) } },
    ]}],
  });
  return data?.choices?.[0]?.message?.content?.trim() || "";
}
