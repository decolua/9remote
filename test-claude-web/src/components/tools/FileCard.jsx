// test-claude-web/src/components/tools/FileCard.jsx
import React from "react";

export function FileCard({ toolName, input, result }) {
  const isWrite = toolName === "Write";
  const filePath = input.file_path || "file";
  const content = isWrite ? input.content : result?.output;

  return (
    <div className="tool-card file-card">
      <div className="tool-card-header file-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`font-semibold text-xs ${isWrite ? "text-blue-400" : "text-slate-300"}`}>
            {isWrite ? "📄 Ghi file:" : "🔍 Đọc file:"}
          </span>
          <span className="text-slate-200 font-mono text-xs truncate">{filePath}</span>
        </div>
        {input.offset && (
          <span className="text-[11px] text-slate-400 font-mono">
            Dòng {input.offset}{input.limit ? `-${input.offset + input.limit}` : ""}
          </span>
        )}
      </div>
      {content && (
        <pre className="p-3 bg-black/40 text-slate-300 font-mono text-xs max-h-44 overflow-y-auto whitespace-pre-wrap leading-relaxed border-t border-white/5">
          {content.slice(0, 500)}
          {content.length > 500 ? "\n..." : ""}
        </pre>
      )}
      <div className="px-3 py-1.5 bg-white/[0.02] text-[11px] text-slate-400 border-t border-white/5">
        {result ? (result.isError ? "✗ Lỗi thao tác file" : "✓ Hoàn tất") : "Đang thực hiện..."}
      </div>
    </div>
  );
}
