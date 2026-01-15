import CryptoJS from "crypto-js";

// Secret key for encryption (same as CLI)
const SECRET_KEY = "9remote-secret-2026-v1";

/**
 * Decrypt token and validate expiry
 * @param {string} token - Encrypted token
 * @returns {{ key: string, exp: number } | null}
 */
export function decryptToken(token) {
  try {
    const decrypted = CryptoJS.AES.decrypt(
      decodeURIComponent(token),
      SECRET_KEY
    ).toString(CryptoJS.enc.Utf8);
    
    const payload = JSON.parse(decrypted);
    
    // Check expiry
    if (Date.now() > payload.exp) {
      return null; // Expired
    }
    
    return payload;
  } catch {
    return null;
  }
}
