// test-claude-web/src/components/tools/DiffCard.jsx
import React from "react";

export function DiffCard({ input, result }) {
  const filePath = input.file_path || "file";
  const oldLines = (input.old_string || "").split("\n");
  const newLines = (input.new_string || "").split("\n");

  return (
    <div className="tool-card diff-card">
      <div className="tool-card-header diff-header">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 font-semibold text-xs">📝 Sửa file:</span>
          <span className="text-slate-200 font-mono text-xs truncate">{filePath}</span>
        </div>
        <span className="text-[11px] text-slate-400">
          <span className="text-rose-400">-{oldLines.length}</span> / <span className="text-emerald-400">+{newLines.length} dòng</span>
        </span>
      </div>
      <div className="p-3 font-mono text-xs overflow-x-auto">
        {input.old_string && (
          <div className="bg-rose-500/15 text-rose-300 p-2 rounded border-l-2 border-rose-500 mb-1.5 whitespace-pre-wrap">
            {input.old_string.slice(0, 300)}
          </div>
        )}
        {input.new_string && (
          <div className="bg-emerald-500/15 text-emerald-300 p-2 rounded border-l-2 border-emerald-500 whitespace-pre-wrap">
            {input.new_string.slice(0, 300)}
          </div>
        )}
        <div className="mt-2 text-[11px] text-slate-400">
          {result ? (result.isError ? "✗ Áp dụng thất bại" : "✓ Đã áp dụng thay đổi vào file") : "Đang áp dụng diff..."}
        </div>
      </div>
    </div>
  );
}
