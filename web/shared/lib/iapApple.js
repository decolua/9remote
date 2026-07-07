// Apple App Store Server API v2 verify — Web Crypto (no Node deps).
// ponytail: no JWS signature verification on signedTransactionInfo (Apple already
// authenticated via TLS + our ES256 bearer). Add verification if hardening required.

const PROD_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

function b64urlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pemToDerBytes(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "").replace(/\\n/g, "");
  return b64urlDecode(b64);
}

function decodeJWTPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
}

// Import ES256 private key (PKCS8 PEM → CryptoKey)
async function importAppleKey(env) {
  const keyId = env.APPLE_KEY_ID;
  const issuerId = env.APPLE_ISSUER_ID;
  const privateKeyPem = env.APPLE_PRIVATE_KEY;
  const bundleId = env.APPLE_BUNDLE_ID;
  if (!keyId || !issuerId || !privateKeyPem || !bundleId) {
    throw new Error("Missing Apple Server API config");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDerBytes(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );
  return { key, keyId, issuerId, bundleId };
}

async function signAppleJWT({ key, issuerId, bundleId }) {
  const header = { alg: "ES256", kid: key.keyId, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 3600, aud: "appstoreconnect-v1", bid: bundleId };
  const enc = (o) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key.key, new TextEncoder().encode(data)
  ));
  const sigB64 = btoa(String.fromCharCode(...sig)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}

export async function verifyAppleTransaction(env, { transactionId, receipt, productId }) {
  if (!transactionId) return { verified: false, error: "Missing transactionId" };
  let cfg;
  try {
    cfg = await importAppleKey(env);
  } catch (e) {
    return { verified: false, error: e.message };
  }
  const token = await signAppleJWT(cfg);

  // Try production first, fall back to sandbox
  for (const base of [PROD_BASE, SANDBOX_BASE]) {
    try {
      const res = await fetch(`${base}/inApps/v1/transactions/${transactionId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { verified: false, error: `Apple API ${res.status}: ${err.errorMessage || ""}` };
      }
      const data = await res.json();
      if (!data.signedTransactionInfo) continue;
      const info = decodeJWTPayload(data.signedTransactionInfo);
      if (info.productId !== productId) return { verified: false, error: "Product mismatch" };
      return {
        verified: true,
        expiresAt: info.expiresDateMs ? new Date(Number(info.expiresDateMs)).toISOString() : null,
        originalPurchaseDate: info.originalPurchaseDate
          ? new Date(Number(info.originalPurchaseDate)).toISOString() : null
      };
    } catch (e) {
      // try next base
    }
  }
  return { verified: false, error: "Transaction not found in prod or sandbox" };
}
