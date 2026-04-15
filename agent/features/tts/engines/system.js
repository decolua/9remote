import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

export const name = "system";
export const refreshInterval = Infinity;
export const retryInterval = 0;
export const defaultVoice = "Linh"; // macOS Vietnamese voice

export async function getToken() {
  return {}; // No token needed
}

export async function getAudio(voiceId, text) {
  const tmpFile = `${tmpdir()}/tts-${randomUUID()}.aiff`;
  const mp3File = tmpFile.replace(".aiff", ".mp3");
  const safeText = text.replace(/"/g, "").slice(0, 500);

  if (process.platform === "darwin") {
    execSync(`say -v "${voiceId || defaultVoice}" -o "${tmpFile}" "${safeText}"`);
    try {
      execSync(`afconvert -f mp4f -d aac "${tmpFile}" "${mp3File}"`);
      const audio = readFileSync(mp3File).toString("base64");
      unlinkSync(tmpFile);
      unlinkSync(mp3File);
      return audio;
    } catch {
      const audio = readFileSync(tmpFile).toString("base64");
      unlinkSync(tmpFile);
      return audio;
    }
  } else {
    execSync(`espeak "${safeText}" -w "${tmpFile}"`, { windowsHide: true });
    const audio = readFileSync(tmpFile).toString("base64");
    unlinkSync(tmpFile);
    return audio;
  }
}
