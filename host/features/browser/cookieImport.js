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

// Content sniffer for pasted imports: JSON first, Netscape flat format second.
export function parseCookiesContent(text) {
  const raw = String(text || "");
  const fromJson = parseCookiesJson(raw);
  return fromJson.length > 0 ? fromJson : parseNetscapeCookies(raw);
}

// No file-path import by design: a client-supplied path would be an
// arbitrary-file-read primitive. Pasted content only (JSON or Netscape).
export async function importCookiesToSession(client, sessionId, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return { imported: 0 };
  // CDP rejects the WHOLE batch over one malformed cookie ("Invalid cookie
  // fields") — normalize hard, then fall back to per-cookie sends and skip
  // whatever Chrome still refuses.
  const clean = cookies
    .filter((c) => c && typeof c.name === "string" && c.name
      && typeof c.value === "string" && typeof c.domain === "string" && c.domain)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === "string" && c.path ? c.path : "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      ...(["Strict", "Lax", "None"].includes(c.sameSite) ? { sameSite: c.sameSite } : {}),
      ...(Number.isFinite(c.expires) && c.expires > 0 ? { expires: c.expires } : {})
    }));
  if (!clean.length) return { imported: 0 };
  try {
    await client.call("Network.setCookies", { cookies: clean }, sessionId);
    return { imported: clean.length };
  } catch {
    let imported = 0;
    for (const c of clean) {
      try {
        await client.call("Network.setCookies", { cookies: [c] }, sessionId);
        imported += 1;
      } catch { /* Chrome refuses this one — skip */ }
    }
    return { imported };
  }
}
