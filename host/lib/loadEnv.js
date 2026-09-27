import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { CLAUDE_SCROLLBACK_ENV } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Search order: explicit process.env (win) > ~/.9remote/.env > agent/.env (dev)
const ENV_FILES = [
  join(os.homedir(), ".9remote", ".env"),
  join(__dirname, "..", ".env")
];

function parseAndAssign(content) {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

for (const file of ENV_FILES) {
  if (existsSync(file)) {
    try { parseAndAssign(readFileSync(file, "utf8")); } catch {}
  }
}

// Inherited by daemon/shell/AI CLIs; user .env takes precedence
for (const [k, v] of Object.entries(CLAUDE_SCROLLBACK_ENV)) {
  if (!process.env[k]) process.env[k] = v;
}
