// Materialize a chat attachment on the host so the CLI can read it, mirroring what
// pasting into the terminal achieves. An image becomes a base64 content block (the
// CLI sends it to the model as an image). Anything else is written to the upload
// directory and handed over as its path, which the CLI reads like any other file.
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR } from "./constants.js";

// The directory must exist before the first write; the daemon's copy of this module
// is what runs for a chat session, and nothing else creates it on that path.
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

// Mirrors InputHandler's guard — a client-supplied name is written to disk, so it
// may never steer the path.
const safeFilename = (name) => (name || "paste").replace(/[^a-zA-Z0-9._-]/g, "_");

export function stageAttachment({ filename, type, content }) {
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFilename(filename)}`);
  fs.writeFileSync(filePath, Buffer.from(content, "base64"));
  if (typeof type === "string" && type.startsWith("image/")) {
    return { kind: "image", mediaType: type, data: content };
  }
  return { kind: "file", path: filePath };
}

/**
 * Build the stream-json user message: staged images ride as content blocks, staged
 * files contribute their path to the text. Returns null when nothing was staged,
 * so the caller can fall back to the plain text message.
 */
export function buildAttachedMessage(text, staged) {
  if (!staged?.length) return null;

  const images = staged.filter((a) => a.kind === "image");
  // Trailing space separates a path from whatever follows it.
  const paths = staged.filter((a) => a.kind === "file").map((a) => a.path).join(" ");
  const body = [paths, text].filter(Boolean).join(" ");

  const content = [
    ...images.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })),
    { type: "text", text: body },
  ];
  return { type: "user", message: { role: "user", content } };
}
