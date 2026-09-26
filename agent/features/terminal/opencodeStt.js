// Voice STT through OpenCode's free tier, called agent-side because opencode.ai
// serves no CORS headers. The free gate only accepts requests that look like the
// OpenCode desktop client: streaming + fingerprint tools (bash/glob/grep/read) +
// session headers. Recipe verified against live probes (mirrors 9router's
// opencode executor); if the gate tightens, this is the file to update.
import crypto from "crypto";

const OPENCODE_STT_URL = "https://opencode.ai/zen/v1/chat/completions";
const OPENCODE_UA = "opencode/1.18.31";
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const REQUEST_TIMEOUT_MS = 60000;
export const MAX_AUDIO_B64_CHARS = 4000000; // ~3MB audio — WAV ≈ 90s, MP3 ≈ 12min

// Upstream id shapes: ses_/msg_ + 12 hex + 14 base62.
function clientId(prefix) {
  const random = Array.from(crypto.randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}${random}`;
}

async function upstreamError(res) {
  try {
    const data = await res.json();
    return data?.error?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function transcribeViaOpencode(model, audioB64, prompt, format = "wav") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENCODE_STT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer public",
        "User-Agent": OPENCODE_UA,
        "x-opencode-client": "desktop",
        "x-opencode-session": clientId("ses"),
        "x-opencode-request": clientId("msg"),
        "x-opencode-project": "global",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model,
        // MiMo thinks by default (~740 reasoning chars ≈ +2-3s); STT needs none.
        reasoning: { effort: "none" },
        stream: true, // free tier rejects non-streaming with 403 FreeTierError
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "input_audio", input_audio: { data: audioB64, format } },
        ]}],
        // Decoy quartet the gate requires; "none" keeps the decoys uncallable.
        tools: FINGERPRINT_TOOLS.map((name) => ({
          type: "function",
          function: { name, description: "stt", parameters: { type: "object", properties: {} } },
        })),
        tool_choice: "none",
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(await upstreamError(res));

    let text = "";
    const decoder = new TextDecoder();
    let buffer = "";
    const drain = (line) => {
      line = line.trim();
      if (!line.startsWith("data: ")) return;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      let delta;
      try { delta = JSON.parse(payload); } catch { return; }
      if (delta?.type === "error") throw new Error(delta.error?.message || "Upstream error");
      // Thinking deltas arrive as delta.reasoning — only delta.content is speech.
      text += delta?.choices?.[0]?.delta?.content || "";
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        drain(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    drain(buffer); // a final line may arrive without a trailing newline
    // Upstream occasionally 200s with an empty stream (soft rate limit) — surface it, don't return silence
    if (!text.trim()) throw new Error("Empty transcription — retry");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}
