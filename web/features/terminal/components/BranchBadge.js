"use client";

import { GitBranch } from "@/shared/components/ui/Icon";

// Branch name of a git root, with a "*" when the tree is dirty. Shared so every surface
// that names a branch renders it the same way.
export default function BranchBadge({ branch, dirty, size = 10, className = "" }) {
  if (!branch) return null;
  return (
    <span className={`inline-flex items-center gap-0.5 min-w-0 ${className}`} title={branch}>
      <GitBranch size={size} className="flex-shrink-0 opacity-70" />
      <span className="truncate">{branch}{dirty ? "*" : ""}</span>
    </span>
  );
}
