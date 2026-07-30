// OTA manifest build + sign (Expo Updates protocol v1).
// Workers runtime: no node:crypto.createSign — signing uses WebCrypto.
// The signature is computed over the EXACT serialized string, and that same
// string is what the route serves, so verify(bytes) == true on the client.
import { SIGN_ALG } from "../constants/index.js";

// env value may carry escaped newlines from .dev.vars ("...\\n...")
// and occasionally CRLF; normalize to a clean PEM before importing.
function normalizePem(pem) {
  return String(pem || "")
    .replace(/\\r/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();
}

let keyRef = { pem: null, key: null };

async function importPrivateKey(pem) {
  const normalized = normalizePem(pem);
  // PKCS#8 base64 body between the PEM headers
  const body = normalized
    .replace(/-----BEGIN.*?-----/g, "")
    .replace(/-----END.*?-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getSigningKey(pem) {
  if (keyRef.pem === pem && keyRef.key) return keyRef.key;
  const key = await importPrivateKey(pem);
  keyRef = { pem, key };
  return key;
}

// Build the R2 url for an asset. The key must NOT carry the file extension —
// the client appends manifest.fileExtension itself; a duplicated extension
// makes the local write path invalid (AssetsFailedToLoad -> update loop).
export function buildAssetUrl(storageKey, r2PublicBase) {
  const base = String(r2PublicBase || "").replace(/\/$/, "");
  const key = String(storageKey || "").replace(/^\//, "");
  return `${base}/${key}`;
}

// One asset -> protocol-conformant manifest Asset.
// launch asset omits fileExtension per Expo spec (ignored for the entry bundle).
function buildAsset(asset, r2PublicBase, isLaunch = false) {
  const out = {
    hash: asset.fileSHA256,
    key: asset.bundleKey,
    contentType: asset.contentType,
    url: buildAssetUrl(asset.storageKey, r2PublicBase)
  };
  if (!isLaunch) out.fileExtension = asset.fileExtension;
  return out;
}

// Build the protocol-conformant manifest object from a stored updateGroup.
export function buildManifest(updateGroup, r2PublicBase) {
  const all = updateGroup.assets || [];
  const launch = all.find((a) => a.storageKey === updateGroup.launchAssetKey);

  // Exclude the launch asset (bundle) from assets[]; Expo spec keeps them separate
  const assets = all
    .filter((a) => a.storageKey !== updateGroup.launchAssetKey)
    .map((a) => buildAsset(a, r2PublicBase));

  const expoConfig = updateGroup.expoConfig || {};
  const eas = expoConfig.extra?.eas;

  return {
    id: updateGroup.id,
    createdAt: new Date(updateGroup.createdAt).toISOString(),
    runtimeVersion: updateGroup.runtimeVersion,
    launchAsset: buildAsset(launch, r2PublicBase, true),
    assets,
    metadata: {},
    extra: { expoClient: expoConfig, ...(eas && { eas }) }
  };
}

// Sign a JSON-stringified body; return an Expo SFV signature dictionary.
// Returns null when no private key is configured (signing disabled).
export async function signBody(bodyString, pemPrivateKey, keyId) {
  if (!pemPrivateKey) return null;

  const key = await getSigningKey(pemPrivateKey);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(bodyString)
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return `sig="${b64}", keyid="${keyId}", alg="${SIGN_ALG}"`;
}

// Build manifest + sign the EXACT serialized string (so serve == signed bytes).
export async function buildSignedManifest(updateGroup, r2PublicBase, pemPrivateKey, keyId) {
  const manifestJson = buildManifest(updateGroup, r2PublicBase);
  const manifestString = JSON.stringify(manifestJson);
  const signature = (await signBody(manifestString, pemPrivateKey, keyId)) || "";
  return { manifestJson, manifestString, signature };
}

// Build a multipart/mixed body (Expo Updates protocol v1 framing).
// expo-signature rides on the manifest part only; extensions has none.
export function buildMultipart(parts) {
  const boundary = `expo-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const segments = [];

  for (const part of parts) {
    let head = `--${boundary}\r\n`;
    head += `content-disposition: form-data; name="${part.name}"\r\n`;
    head += `content-type: ${part.contentType}\r\n`;
    if (part.signature) head += `expo-signature: ${part.signature}\r\n`;
    head += `\r\n`;
    segments.push(head + part.body + `\r\n`);
  }
  segments.push(`--${boundary}--\r\n`);

  return { boundary, body: segments.join("") };
}
