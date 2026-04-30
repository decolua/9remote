"use client";

import { PAGE_SIZE_OPTIONS } from "../constants";

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-sm text-text-muted">
      <div>
        Total: <span className="text-text font-medium">{total}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
          className="bg-surface-2 rounded-brand px-2 py-1 text-text"
        >
          {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}/page</option>)}
        </select>
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="px-3 py-1 rounded-brand bg-surface-2 hover:bg-surface-3 disabled:opacity-40"
        >Prev</button>
        <span className="whitespace-nowrap">{page} / {totalPages}</span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="px-3 py-1 rounded-brand bg-surface-2 hover:bg-surface-3 disabled:opacity-40"
        >Next</button>
      </div>
    </div>
  );
}
