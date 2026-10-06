import fs from "node:fs";

export function parseNetscapeCookies(text) {
  const cookies = [];
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = parts;
    cookies.push({
      domain,
      path: path || "/",
      secure: secure.toLowerCase() === "true",
      expires: Number(expires) || -1,
      name,
      value
    });
  }
  return cookies;
}

export function parseCookiesJson(text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      return data.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite || "Lax",
        expires: typeof c.expirationDate === "number" ? Math.round(c.expirationDate) : (typeof c.expires === "number" ? Math.round(c.expires) : undefined)
      })).filter((c) => c.name && c.value && c.domain);
    }
  } catch { /* not json */ }
  return [];
}

export function parseCookiesFromFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const content = fs.readFileSync(filePath, "utf8");
  const fromJson = parseCookiesJson(content);
  if (fromJson.length > 0) return fromJson;
  return parseNetscapeCookies(content);
}

export async function importCookiesToSession(client, sessionId, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return { imported: 0 };
  const valid = cookies.filter((c) => c && c.name && c.value && c.domain);
  if (!valid.length) return { imported: 0 };
  await client.call("Network.setCookies", { cookies: valid }, sessionId);
  return { imported: valid.length };
}
