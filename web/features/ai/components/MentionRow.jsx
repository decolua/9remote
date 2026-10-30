"use client";

import { memo } from "react";

// `@` row: dimmed folders, bright basename, matched characters bolded so the
// reason a file ranked where it did is visible at a glance.
export const MentionRow = memo(function MentionRow({ item }) {
  const slash = item.label.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : item.label.slice(0, slash + 1);
  const basePart = slash === -1 ? item.label : item.label.slice(slash + 1);
  const hit = new Set(item.positions || []);
  const render = (chunk, offset) => [...chunk].map((ch, i) => (hit.has(offset + i)
    ? <span key={offset + i} className="text-accent font-semibold">{ch}</span>
    : <span key={offset + i}>{ch}</span>));

  return (
    <span className="font-mono text-xs min-w-0 flex flex-1 items-baseline">
      {/* dir clips from the left so the basename never loses room on a phone */}
      <span className="min-w-0 truncate text-text-muted" style={{ direction: "rtl", unicodeBidi: "plaintext" }}>
        {render(dirPart, 0)}
      </span>
      <span className={`shrink-0 ${item.isDir ? "text-brand-500" : "text-text"}`}>
        {render(basePart, dirPart.length)}
        {item.isDir ? "/" : ""}
      </span>
    </span>
  );
});
