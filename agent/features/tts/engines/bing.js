import fetch from "node-fetch";

export const name = "bing";
export const refreshInterval = 10 * 60 * 1000; // 10 min
export const retryInterval = 5 * 60 * 1000;    // 5 min cooldown after error

export const VOICES = {
  female: "vi-VN-HoaiMyNeural",
  male: "vi-VN-NamMinhNeural",
};
export const defaultVoice = VOICES.female;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const TTS_URL = "https://www.bing.com/tfettts?isVertical=1&&IG=1&IID=translator.5023";

export async function getToken() {
  const res = await fetch("https://www.bing.com/translator", {
    headers: { "User-Agent": UA, "Accept-Language": "vi,en-US;q=0.9,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`Bing translator fetch failed: ${res.status}`);

  // Extract cookies for subsequent requests
  const rawCookies = res.headers.raw?.()?.["set-cookie"] || [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");

  const html = await res.text();
  const match = html.match(/params_AbusePreventionHelper\s*=\s*\[([^,]+),([^,]+),/);
  if (!match) throw new Error("Failed to parse Bing token");

  return { key: match[1], token: match[2].replace(/"/g, ""), cookie };
}

export async function getAudio(voiceId, text, token) {
  const ssml = `<speak version='1.0' xml:lang='vi-VN'><voice xml:lang='vi-VN' xml:gender='Female' name='${voiceId}'><prosody rate='0.00%'>${text}</prosody></voice></speak>`;

  const body = new URLSearchParams();
  body.append("ssml", ssml);
  body.append("token", token.token);
  body.append("key", token.key);

  const res = await fetch(TTS_URL, {
    method: "POST",
    body: "&" + body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
      "Origin": "https://www.bing.com",
      "Referer": "https://www.bing.com/translator",
      "User-Agent": UA,
      ...(token.cookie ? { "Cookie": token.cookie } : {}),
    },
  });

  if (res.status === 429) throw new Error("Bing TTS rate limited (429)");
  if (!res.ok) throw new Error(`Bing TTS failed: ${res.status}`);

  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1024) throw new Error("Bing TTS returned empty audio");

  return Buffer.from(buf).toString("base64");
}
