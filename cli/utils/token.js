import CryptoJS from "crypto-js";

// Secret key for encryption (same on CLI and Worker)
const SECRET_KEY = "9remote-secret-2026-v1";

/**
 * Create encrypted token with key and expiry
 * @param {string} apiKey - API key to encrypt
 * @param {number} expiryMinutes - Token expiry in minutes (default 5)
 * @returns {string} Encrypted token
 */
export function createToken(apiKey, expiryMinutes = 5) {
  const payload = {
    key: apiKey,
    exp: Date.now() + expiryMinutes * 60 * 1000
  };
  
  const encrypted = CryptoJS.AES.encrypt(
    JSON.stringify(payload),
    SECRET_KEY
  ).toString();
  
  // Make URL-safe
  return encodeURIComponent(encrypted);
}

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
