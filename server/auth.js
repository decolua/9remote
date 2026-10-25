import { randomBytes, createHash, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(derive);
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function passwordHash(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("Password must contain 12–1024 characters");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
}
export async function verifyPassword(password, saved) {
  if (typeof password !== "string" || password.length > 1024 || !saved) return false;
  const [salt, hash] = saved.split(":");
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}
