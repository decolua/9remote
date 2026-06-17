import CryptoJS from "crypto-js";

/**
 * Decrypt token and validate expiry. Secret from env.TOKEN_SECRET.
 * @param {string} token - Encrypted token (URL-encoded)
 * @param {object} env - Cloudflare Workers env
 * @returns {{ key: string, exp: number } | null}
 */
export function decryptToken(token, env) {
  if (!env?.TOKEN_SECRET) throw new Error("TOKEN_SECRET not configured");
  try {
    const decrypted = CryptoJS.AES.decrypt(
      decodeURIComponent(token),
      env.TOKEN_SECRET
    ).toString(CryptoJS.enc.Utf8);
    const payload = JSON.parse(decrypted);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
