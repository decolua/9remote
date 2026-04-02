// Prepare text for TTS: strip markdown, emoji, special chars that break SSML
const MAX_LENGTH = 500;

// Strip markdown syntax
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")          // code blocks
    .replace(/`[^`]*`/g, "")                  // inline code
    .replace(/!\[.*?\]\(.*?\)/g, "")          // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links → keep label
    .replace(/^#{1,6}\s+/gm, "")             // headings
    .replace(/(\*\*|__)(.*?)\1/g, "$2")       // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")          // italic
    .replace(/~~(.*?)~~/g, "$1")              // strikethrough
    .replace(/^[-*+]\s+/gm, "")              // list bullets
    .replace(/^\d+\.\s+/gm, "")              // ordered list
    .replace(/^>\s+/gm, "")                  // blockquotes
    .replace(/\|.*\|/g, "")                  // tables
    .replace(/^[-=]{3,}$/gm, "");            // horizontal rules
}

// Strip emoji
function stripEmoji(text) {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Emoji}\u200d\uFE0F]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "");  // misc symbols
}

// Strip chars that break SSML or TTS engines
function stripSpecialChars(text) {
  return text
    .replace(/<[^>]+>/g, " ")             // HTML/XML tags
    .replace(/[<>&"']/g, " ")              // SSML reserved
    .replace(/[@^*()\\+=>【】""'']/g, " ") // problematic chars
    .replace(/,\s/g, ". ")                 // comma pause → period
    .replace(/\s{2,}/g, " ")              // collapse whitespace
    .trim();
}

export function filterText(text) {
  if (!text || typeof text !== "string") return "";

  let result = text;
  result = stripMarkdown(result);
  result = stripEmoji(result);
  result = stripSpecialChars(result);

  // Truncate to max length at sentence boundary
  if (result.length > MAX_LENGTH) {
    const truncated = result.slice(0, MAX_LENGTH);
    const lastSentence = truncated.lastIndexOf(".");
    result = lastSentence > MAX_LENGTH * 0.5 ? truncated.slice(0, lastSentence + 1) : truncated;
  }

  return result.trim();
}
