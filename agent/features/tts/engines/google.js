import fetch from "node-fetch";

export const name = "google";
export const refreshInterval = 11 * 60 * 1000; // 11 min
export const retryInterval = 5 * 60 * 1000;    // 5 min cooldown after error

export const VOICES = {
  female: "default",
};
export const defaultVoice = VOICES.female;

export async function getToken() {
  const res = await fetch("https://translate.google.com/", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Google translate fetch failed: ${res.status}`);

  const html = await res.text();
  const fSid = html.match(/"FdrFJe":"(.*?)"/)?.[1];
  const bl = html.match(/"cfb2h":"(.*?)"/)?.[1];
  if (!fSid || !bl) throw new Error("Failed to parse Google token");

  return { "f.sid": fSid, bl };
}

let _speakIndex = 0;

export async function getAudio(voiceId, text, token) {
  // Sanitize text
  const cleanText = text.replace(/[@^*()\\/\-_+=><"'""【】]/g, " ").replaceAll(", ", ". ");

  const rpcId = "jQ1olc";
  const reqId = (++_speakIndex * 100000) + Math.floor(1000 + Math.random() * 9000);
  const query = new URLSearchParams({
    rpcids: rpcId,
    "f.sid": token["f.sid"],
    bl: token.bl,
    hl: "vi",
    "soc-app": 1,
    "soc-platform": 1,
    "soc-device": 1,
    _reqid: reqId,
    rt: "c",
  });

  const payload = [cleanText, "vi", null, "undefined", [0]];
  const body = new URLSearchParams();
  body.append("f.req", JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]));

  const res = await fetch(`https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://translate.google.com/",
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`Google TTS failed: ${res.status}`);

  const data = await res.text();
  const split = JSON.parse(data.split("\n")[3]);
  const base64 = JSON.parse(split[0][2])[0];

  if (!base64 || base64.length < 1365) throw new Error("Google TTS returned empty audio");

  return base64;
}
