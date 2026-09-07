"use client";

import { ChevronLeft, ChevronRight } from "@/shared/components/ui/Icon";
import { PAGE_SIZE_OPTIONS } from "../constants";

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-xs text-text-muted">
      <div className="flex items-center gap-1.5 font-mono">
        <span>Total:</span>
        <span className="text-text font-semibold px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle">
          {total}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
          className="bg-surface-2 border border-border-subtle rounded-lg px-2.5 py-1 text-text text-xs focus:outline-none"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="p-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-2.5 py-1 font-mono text-xs text-text">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="p-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
