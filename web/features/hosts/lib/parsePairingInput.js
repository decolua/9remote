// One-time pairing input → { tempKey, tail }. A 6-char code routes to the host's
// temp key; the optional 2-char TAIL is the device's proof of the key it holds.
// Shared by the login page and the in-app "add host" modal.
export function parsePairingInput(raw) {
  const str = String(raw || "").trim();
  const split = (code) => ({
    tempKey: code.slice(0, 6).toUpperCase(),
    tail: code.slice(6, 8).toUpperCase()
  });

  const hashMatch = /#([A-NP-Z1-9]{6}-?[a-np-z1-9]{2})$/i.exec(str);
  if (hashMatch) return split(hashMatch[1].replace(/-/g, ""));

  const codeMatch = /^([A-NP-Z1-9]{6}-?[a-np-z1-9]{2})$/i.exec(str);
  if (codeMatch) return split(codeMatch[1].replace(/-/g, ""));

  const kMatch = /[?&]k=([A-NP-Z1-9]{6})(?:[^A-NP-Z1-9]|$)/i.exec(str);
  if (kMatch) return { tempKey: kMatch[1].toUpperCase() };
  if (/^[A-NP-Z1-9]{6}$/i.test(str)) return { tempKey: str.toUpperCase() };
  return null;
}
