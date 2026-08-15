// Reads a Claude session transcript (.jsonl) into chat rows.
//
// Hooks report what the CLI DOES — tool calls, waits, turn boundaries. They never carry
// what it SAYS. The assistant's prose only exists in this file, so the chat view reads it
// here. The file is written continuously by another process, so every parse step tolerates
// a half-written final line.
import fs from "fs";
import { MAX_STORED_TEXT } from "./constants.js";

// Newest turns are what the user is looking at; older ones stay in the terminal scrollback.
const DEFAULT_MAX_ROWS = 300;

// Text the harness injects into the conversation. It is addressed to the model, not typed
// by the user, and showing it would misrepresent what was said.
const META_PREFIXES = ["<system-reminder", "<local-command", "<command-name", "<command-message", "<command-args"];

const clip = (s) => {
  if (typeof s !== "string") return s;
  return s.length > MAX_STORED_TEXT ? `${s.slice(0, MAX_STORED_TEXT)}\n… [truncated]` : s;
};

const isMetaText = (text) => {
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
};

// tool_result content arrives either as a plain string or as content blocks.
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n");
}

function userText(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text").map((b) => b.text || "").filter(Boolean).join("\n");
}

/** Turn parsed transcript records into ordered chat rows. */
export function parseTranscriptLines(lines) {
  const rows = [];
  // tool_use id → the row awaiting its result, so a later tool_result completes it in place.
  const pendingTools = new Map();

  for (const raw of lines) {
    let rec = raw;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) continue;
      // The last line can be half-written while Claude is still streaming.
      try { rec = JSON.parse(s); } catch { continue; }
    }
    if (!rec || typeof rec !== "object") continue;
    // Subagent traffic belongs to its own thread, not the conversation the user is reading.
    if (rec.isSidechain) continue;

    const message = rec.message;
    if (!message) continue;
    const at = rec.timestamp ? Date.parse(rec.timestamp) : null;
    const uuid = rec.uuid || `r${rows.length}`;

    if (rec.type === "user") {
      // Pair up tool results first — they arrive as user records but are not user speech.
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const target = pendingTools.get(b.tool_use_id);
        if (!target) continue;
        target.status = b.is_error ? "error" : "done";
        target.toolResponse = clip(flattenContent(b.content));
        target.doneAt = at;
        pendingTools.delete(b.tool_use_id);
      }
      if (rec.isMeta) continue;
      const text = userText(message).trim();
      if (!text || isMetaText(text)) continue;
      rows.push({ id: uuid, kind: "userPrompt", text: clip(text), at });
      continue;
    }

    if (rec.type !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    blocks.forEach((b, i) => {
      const id = `${uuid}-${i}`;
      if (b?.type === "text") {
        const text = (b.text || "").trim();
        if (text) rows.push({ id, kind: "assistantText", text: clip(text), at });
        return;
      }
      if (b?.type === "thinking") {
        const text = (b.thinking || "").trim();
        if (text) rows.push({ id, kind: "thinking", text: clip(text), at });
        return;
      }
      if (b?.type === "tool_use") {
        const row = {
          id, kind: "tool", toolUseId: b.id || null,
          toolName: b.name || "Tool", toolInput: b.input ?? null,
          status: "running", toolResponse: null, at,
        };
        rows.push(row);
        if (b.id) pendingTools.set(b.id, row);
      }
    });
  }

  return rows;
}

/** Read a transcript from disk. Returns { rows, size } — size lets a caller skip re-reads. */
export function readTranscript(filePath, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  if (!filePath) return { rows: [], size: 0 };
  let content;
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // A brand-new session has no transcript for a few seconds — absence is normal here.
    return { rows: [], size: 0 };
  }
  const rows = parseTranscriptLines(content.split("\n"));
  return { rows: rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows, size };
}
