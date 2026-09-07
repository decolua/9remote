import CryptoJS from "crypto-js";

/**
 * Decrypt token and validate expiry. Secret from env.TOKEN_SECRET or env.APP_SECRET.
 * @param {string} token - Encrypted token (URL-encoded)
 * @param {object} env - Cloudflare Workers env
 * @returns {{ key: string, exp: number } | null}
 */
export function decryptToken(token, env) {
  const secret = env?.TOKEN_SECRET || env?.APP_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET or APP_SECRET not configured");
  try {
    const decrypted = CryptoJS.AES.decrypt(
      decodeURIComponent(token),
      secret
    ).toString(CryptoJS.enc.Utf8);
    const payload = JSON.parse(decrypted);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
