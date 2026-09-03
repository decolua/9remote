// Append entry to .gitignore in workspace if not already present.
import { joinPath } from "./pathUtils.js";

export async function addToGitignore(fileBus, workspace, relPath, isFolder = false) {
  if (!fileBus || !workspace || !relPath) return { success: false };
  const gitignorePath = joinPath(workspace, ".gitignore");
  let entry = relPath.replace(/^\/+/, "");
  if (isFolder && !entry.endsWith("/")) {
    entry = `${entry}/`;
  }

  const readRes = await fileBus.readFile(gitignorePath);
  const currentContent = readRes?.success ? (readRes.content || "") : "";

  const lines = currentContent.split(/\r?\n/);
  const trimmed = entry.replace(/\/$/, "");
  if (lines.includes(entry) || lines.includes(trimmed) || lines.includes(`/${entry}`) || lines.includes(`/${trimmed}`)) {
    return { success: true, alreadyIgnored: true };
  }

  const newContent = currentContent
    ? (currentContent.endsWith("\n") ? `${currentContent}${entry}\n` : `${currentContent}\n${entry}\n`)
    : `${entry}\n`;

  return await fileBus.writeFile(gitignorePath, newContent);
}
