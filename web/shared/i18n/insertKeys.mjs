// i18n bulk key inserter — add new keys to ALL locales at once (no manual per-file edits).
// Usage: node web/shared/i18n/insertKeys.mjs <data.json>
// JSON shape: { "anchor": "existingKey", "translations": { "en": { newKey: "..." }, "vi": {...} } }
// Inserts each locale's keys right AFTER the line containing anchor. Idempotent. Missing locale → en fallback.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "locales");

const dataPath = process.argv[2];
if (!dataPath) {
  console.error("Usage: node insertKeys.mjs <data.json>");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(dataPath, "utf8"));
} catch (e) {
  console.error(`Cannot read/parse JSON: ${dataPath}\n${e.message}`);
  process.exit(1);
}

const { anchor, translations } = data;
if (!anchor || !translations || !translations.en) {
  console.error("JSON must have { anchor, translations: { en: {...}, ... } }");
  process.exit(1);
}

const files = readdirSync(LOCALES_DIR).filter(f => f.endsWith(".js") && f !== "index.js");

for (const file of files) {
  const code = file.replace(".js", "");
  const pairs = translations[code] || translations.en;
  const path = join(LOCALES_DIR, file);
  const lines = readFileSync(path, "utf8").split("\n");

  const anchorIdx = lines.findIndex(l => l.includes(`${anchor}:`));
  if (anchorIdx === -1) {
    console.warn(`⚠ ${file}: anchor "${anchor}" not found, skipped`);
    continue;
  }

  // Match anchor indentation so inserted lines align.
  const indent = lines[anchorIdx].match(/^\s*/)[0];
  const newLines = Object.entries(pairs)
    .filter(([k]) => !lines.some(l => l.includes(`${k}:`))) // skip existing
    .map(([k, v]) => `${indent}${k}: "${String(v).replace(/"/g, '\\"')}",`);

  if (newLines.length === 0) {
    console.log(`= ${file}: all keys exist, skipped`);
    continue;
  }

  lines.splice(anchorIdx + 1, 0, ...newLines);
  writeFileSync(path, lines.join("\n"));
  console.log(`✓ ${file}: +${newLines.length} key(s)`);
}
