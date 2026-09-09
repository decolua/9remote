// test-claude-web/src/components/tools/DiffCard.jsx
import React, { useState } from "react";

export function DiffCard({ input, result }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const filePath = input.file_path || "file";
  const oldLines = (input.old_string || "").split("\n");
  const newLines = (input.new_string || "").split("\n");
  const totalLines = oldLines.length + newLines.length;
  const isError = result?.isError;

  const handleCopyNew = () => {
    navigator.clipboard.writeText(input.new_string || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayOld = expanded ? oldLines : oldLines.slice(0, 10);
  const displayNew = expanded ? newLines : newLines.slice(0, 10);

  return (
    <div className="tool-card diff-card">
      {/* Header */}
      <div className="tool-card-header diff-header flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-emerald-400 font-semibold text-xs flex items-center gap-1">
            <span>📝</span> Sửa file:
          </span>
          <span className="text-slate-200 font-mono text-xs truncate max-w-sm" title={filePath}>
            {filePath}
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono select-none">
          <span className="flex items-center gap-1.5">
            <span className="text-rose-400 font-semibold">-{oldLines.length}</span>
            <span className="text-slate-500">/</span>
            <span className="text-emerald-400 font-semibold">+{newLines.length} dòng</span>
          </span>
          <button
            onClick={handleCopyNew}
            className="text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
            title="Sao chép code mới"
          >
            {copied ? "✓ Đã chép" : "📋 Chép"}
          </button>
        </div>
      </div>

      {/* Unified Diff View */}
      <div className="p-3 font-mono text-xs overflow-x-auto flex flex-col gap-0.5 bg-[#080c16]">
        {/* Old lines (-) */}
        {input.old_string && (
          <div className="flex flex-col border-l-2 border-rose-500 bg-rose-950/25 rounded-r overflow-hidden my-0.5">
            {displayOld.map((line, idx) => (
              <div key={idx} className="flex items-start text-rose-300/90 py-0.5 px-2 hover:bg-rose-500/10 font-mono">
                <span className="select-none text-rose-500/60 w-6 flex-shrink-0 text-right pr-2 text-[10px]">
                  {idx + 1}
                </span>
                <span className="select-none text-rose-400 pr-2 font-bold">-</span>
                <span className="whitespace-pre break-words flex-1">{line || " "}</span>
              </div>
            ))}
            {!expanded && oldLines.length > 10 && (
              <div className="text-[10px] text-rose-400/60 italic px-8 py-0.5 select-none">
                ... (+ {oldLines.length - 10} dòng cũ khác)
              </div>
            )}
          </div>
        )}

        {/* New lines (+) */}
        {input.new_string && (
          <div className="flex flex-col border-l-2 border-emerald-500 bg-emerald-950/25 rounded-r overflow-hidden my-0.5">
            {displayNew.map((line, idx) => (
              <div key={idx} className="flex items-start text-emerald-300/90 py-0.5 px-2 hover:bg-emerald-500/10 font-mono">
                <span className="select-none text-emerald-500/60 w-6 flex-shrink-0 text-right pr-2 text-[10px]">
                  {idx + 1}
                </span>
                <span className="select-none text-emerald-400 pr-2 font-bold">+</span>
                <span className="whitespace-pre break-words flex-1">{line || " "}</span>
              </div>
            ))}
            {!expanded && newLines.length > 10 && (
              <div className="text-[10px] text-emerald-400/60 italic px-8 py-0.5 select-none">
                ... (+ {newLines.length - 10} dòng mới khác)
              </div>
            )}
          </div>
        )}

        {/* Footer info & Toggle */}
        <div className="mt-2 pt-1.5 border-t border-white/5 flex items-center justify-between text-[11px] text-slate-400 select-none">
          <div className="flex items-center gap-2">
            <span className={isError ? "text-rose-400 font-semibold" : "text-emerald-400 font-semibold"}>
              {result ? (isError ? "✗ Áp dụng thất bại" : "✓ Đã áp dụng thay đổi vào file") : "Đang áp dụng diff..."}
            </span>
          </div>

          {totalLines > 20 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-sky-400 hover:text-sky-300 font-medium transition-colors"
            >
              {expanded ? "Thu gọn ▲" : `Xem đầy đủ ${totalLines} dòng ▼`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
