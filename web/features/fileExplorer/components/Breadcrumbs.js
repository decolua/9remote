"use client";

import { Fragment } from "react";
import { ChevronRight } from "@/shared/components/ui/Icon";

export default function Breadcrumbs({ workspace, filePath }) {
  if (!filePath) {
    return <div className="bg-bg border-b border-border px-3 py-1 text-xs text-text-muted h-7" />;
  }

  const wsBase = workspace ? workspace.split("/").filter(Boolean).pop() : "";
  const relPath = workspace && filePath.startsWith(workspace + "/")
    ? filePath.slice(workspace.length + 1)
    : filePath;
  const parts = relPath.split("/").filter(Boolean);
  const allParts = wsBase ? [wsBase, ...parts] : parts;
  const lastIdx = allParts.length - 1;

  return (
    <div className="bg-bg border-b border-border px-3 py-1 text-xs text-text-muted flex items-center gap-1 overflow-x-auto whitespace-nowrap">
      {allParts.map((part, idx) => (
        <Fragment key={idx}>
          <span
            className={
              idx === lastIdx
                ? "text-text font-medium"
                : "hover:text-text cursor-default"
            }
          >
            {part}
          </span>
          {idx < lastIdx && <ChevronRight size={12} className="flex-shrink-0" />}
        </Fragment>
      ))}
    </div>
  );
}
