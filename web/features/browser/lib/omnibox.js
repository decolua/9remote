"use client";

// Omnibox resolution, Chrome-style: explicit scheme passes through, a bare
// host.tld / IP / localhost gains https://, anything else is a search query.
export const SEARCH_URL = "https://www.google.com/search?q=";

export function resolveOmniboxInput(raw) {
  const input = String(raw || "").trim();
  if (!input) return null;

  // Explicit scheme: either standard protocol with // (https://, http://, ftp://),
  // or known standalone scheme (about:, data:, chrome:, etc.). Note that
  // "localhost:3000" has a colon followed by digits (port), which is not a scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) || /^(about|data|chrome|javascript|mailto|view-source):/i.test(input)) {
    return { url: input, isSearch: false };
  }

  // First path segment must be a plausible host with no spaces to count as a URL.
  const host = input.split(/[/?#\s]/)[0].replace(/:\d+$/, "");
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[[0-9a-fA-F:]+\]$/.test(host);
  const isHost = host
    && (isIp || host === "localhost" || /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(host));
  if (isHost) return { url: `https://${input}`, isSearch: false };
  return { url: SEARCH_URL + encodeURIComponent(input), isSearch: true };
}
