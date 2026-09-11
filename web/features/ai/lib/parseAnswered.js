// The host's only record of a past AskUserQuestion answer is plain text:
// 'User has answered your questions: "Q"="A", "Q2"="A2".' — parse the pairs back
// out so the card can show question → answer. Null when nothing matches, letting
// the caller fall back to the raw text.
const PAIR = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const unescape = (s) => s.replace(/\\(.)/g, "$1");

export function parseAnswered(text) {
  const pairs = [...String(text || "").matchAll(PAIR)];
  return pairs.length ? Object.fromEntries(pairs.map((m) => [unescape(m[1]), unescape(m[2])])) : null;
}
