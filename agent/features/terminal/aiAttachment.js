// Materialize a chat attachment on the host so the CLI can read it, mirroring what
// pasting into the terminal achieves. What the CLI gets depends on the engine: an
// image may ride as a base64 content block, as a file flag, or as a bare path it
// reads itself (each verified against the real CLI). Anything else is always written
// to disk and handed over as its path, which the CLI reads like any other file.
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
  // The path is returned for images too: engines that take an image as a file
  // argument (codex --image, opencode --file) have no other way to name it.
  if (typeof type === "string" && type.startsWith("image/")) {
    return { kind: "image", mediaType: type, data: content, path: filePath };
  }
  return { kind: "file", path: filePath };
}

// Staged files the CLI has to read itself, as a space-joined path list; "" when
// there are none. Images are skipped by default — an engine that can see them
// carries them its own way (a content block, a flag), never as a bare path.
// includeImages is for engines with no image channel at all, where the path is the
// only way to hand the picture over.
export function stagedPaths(staged, includeImages = false) {
  return (staged || [])
    .filter((a) => a.kind === "file" || (includeImages && a.kind === "image"))
    .map((a) => a.path)
    .join(" ");
}

// What the clients get to render under the user's bubble. Base64 stays out: this
// rides the replay log, which the pane rebuilds in full on every connect.
export function attachmentMeta(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return attachments.map((a) => ({
    filename: a.filename || "file",
    isImage: typeof a.type === "string" && a.type.startsWith("image/")
  }));
}

// Turn a prompt plus staged files into the plain text a non-block CLI takes.
export function buildAttachedPrompt(text, staged, includeImages = false) {
  return [stagedPaths(staged, includeImages), text].filter(Boolean).join(" ");
}

/**
 * Build the stream-json user message: staged images ride as content blocks, staged
 * files contribute their path to the text. Returns null when nothing was staged,
 * so the caller can fall back to the plain text message.
 */
export function buildAttachedMessage(text, staged) {
  if (!staged?.length) return null;

  const images = staged.filter((a) => a.kind === "image");
  const content = [
    ...images.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })),
    { type: "text", text: buildAttachedPrompt(text, staged) },
  ];
  return { type: "user", message: { role: "user", content } };
}
