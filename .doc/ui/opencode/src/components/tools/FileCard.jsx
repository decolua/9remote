// test-claude-web/src/components/tools/FileCard.jsx
import React, { useState } from "react";

export function FileCard({ toolName, input, result }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const isWrite = toolName === "Write";
  const filePath = input.file_path || "file";
  const content = isWrite ? input.content : result?.output;
  const isError = result?.isError;

  const lines = (content || "").split("\n");
  const isLong = lines.length > 20 || (content && content.length > 800);

  const handleCopy = () => {
    navigator.clipboard.writeText(content || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayContent = expanded || !isLong ? content : lines.slice(0, 20).join("\n") + `\n\n... (+ ${lines.length - 20} dòng khác)`;

  return (
    <div className="tool-card file-card">
      <div className="tool-card-header file-header flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-semibold text-xs flex items-center gap-1 ${isWrite ? "text-blue-400" : "text-sky-300"}`}>
            <span>{isWrite ? "📄" : "🔍"}</span> {isWrite ? "Ghi file:" : "Đọc file:"}
          </span>
          <span className="text-slate-200 font-mono text-xs truncate max-w-sm" title={filePath}>
            {filePath}
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono select-none">
          {lines.length > 1 && (
            <span className="text-slate-400 font-semibold">{lines.length} dòng</span>
          )}
          {content && (
            <button
              onClick={handleCopy}
              className="text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
              title="Sao chép nội dung"
            >
              {copied ? "✓ Đã chép" : "📋 Chép"}
            </button>
          )}
        </div>
      </div>

      {content && (
        <pre className="p-3.5 bg-black/40 text-slate-300 font-mono text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed border-t border-white/5 max-h-96">
          {displayContent}
        </pre>
      )}

      <div className="px-3 py-1.5 bg-white/[0.02] text-[11px] text-slate-400 border-t border-white/5 flex items-center justify-between select-none">
        <span className={isError ? "text-rose-400 font-semibold" : "text-emerald-400 font-semibold"}>
          {result ? (isError ? "✗ Lỗi thao tác file" : "✓ Hoàn tất") : "Đang thực hiện..."}
        </span>

        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-sky-400 hover:text-sky-300 font-medium transition-colors"
          >
            {expanded ? "Thu gọn ▲" : `Xem toàn bộ ${lines.length} dòng ▼`}
          </button>
        )}
      </div>
    </div>
  );
}
