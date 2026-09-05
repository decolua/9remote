"use client";

import HtmlViewer from "./HtmlViewer.js";
import MermaidViewer from "./MermaidViewer.js";
import MarkdownViewer from "./MarkdownViewer.js";

// Unified renderer for text files with a rendered preview (html, markdown, mermaid).
export default function TextPreview({ kind, filePath, fileBus, content, reloadKey = 0 }) {
  if (kind === "html") {
    return <HtmlViewer filePath={filePath} fileBus={fileBus} reloadKey={reloadKey} />;
  }
  if (kind === "mermaid") {
    return <MermaidViewer content={content} reloadKey={reloadKey} />;
  }
  if (kind === "markdown") {
    return <MarkdownViewer content={content} />;
  }
  return null;
}
