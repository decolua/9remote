"use client";

// Compiled pick data — the same shape the "Copy for AI" prompt uses, multi-element.
export function buildPickPayload(items, url = null) {
  return [
    `## Browser Elements (${items.length})`,
    url ? `Page: ${url}` : null,
    "",
    ...items.map((it, i) => [
      `### ${i + 1}. \`<${it.tag}>\``,
      `- Selector: \`${it.selector || it.tag}\``,
      it.text ? `- Text: "${it.text}"` : null,
      it.href ? `- Link: ${it.href}` : null,
      it.rect ? `- Rect: ${it.rect.x},${it.rect.y} ${it.rect.width}×${it.rect.height}` : null
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n");
}
