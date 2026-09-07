import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { ADMIN_COOKIE_NAME, ADMIN_TOKEN_TTL_SEC } from "../constants";

const encoder = new TextEncoder();

function getSecret(env) {
  const secret = env?.ADMIN_JWT_SECRET || env?.APP_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET or APP_SECRET not configured");
  return encoder.encode(secret);
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function signAdminToken(env, payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_TOKEN_TTL_SEC}s`)
    .sign(getSecret(env));
}

export async function verifyAdminToken(env, token) {
  try {
    const { payload } = await jwtVerify(token, getSecret(env));
    return payload;
  } catch {
    return null;
  }
}

export function readTokenFromRequest(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`${ADMIN_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Secure would strip the cookie on a plain-http dev origin, so it follows the
// scheme the request actually arrived on rather than being hardcoded.
function secureFlag(request) {
  try {
    return new URL(request.url).protocol === "https:" ? ["Secure"] : [];
  } catch {
    return ["Secure"];
  }
}

export function buildSetCookie(token, request, maxAgeSec = ADMIN_TOKEN_TTL_SEC) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...secureFlag(request),
    `Max-Age=${maxAgeSec}`
  ];
  return parts.join("; ");
}

export function buildClearCookie(request) {
  return [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...secureFlag(request),
    "Max-Age=0"
  ].join("; ");
}
