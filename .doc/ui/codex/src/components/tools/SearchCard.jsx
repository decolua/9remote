// test-claude-web/src/components/tools/SearchCard.jsx
import React, { useState } from "react";

export function SearchCard({ toolName, input = {}, result }) {
  const [expanded, setExpanded] = useState(false);
  const isWeb = toolName.includes("Web") || toolName.includes("exa");
  const isCodeGraph = toolName.includes("codegraph");

  const query = input.query || input.url || input.urls?.join(", ") || "";
  const isFinished = Boolean(result);
  const isError = result?.isError;

  return (
    <div className="tool-card border-blue-500/20 bg-[#070b14]">
      <div className="tool-card-header bg-blue-950/20 border-b border-blue-500/20 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{isCodeGraph ? "🕸️" : "🌐"}</span>
          <span className="font-semibold text-xs text-sky-300">
            {isCodeGraph ? "CodeGraph Tra cứu" : "Web Search / Fetch"}
          </span>
          <span className="text-[10px] font-mono text-slate-400 border border-white/10 px-1.5 py-0.5 rounded">
            {toolName}
          </span>
        </div>

        <div>
          {isFinished ? (
            <span className={`text-[11px] font-mono font-semibold ${isError ? "text-rose-400" : "text-emerald-400"}`}>
              {isError ? "✗ Lỗi tra cứu" : "✓ Hoàn thành"}
            </span>
          ) : (
            <span className="text-[11px] text-sky-400 font-mono flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
              Đang tìm kiếm...
            </span>
          )}
        </div>
      </div>

      <div className="p-3 text-xs flex flex-col gap-2">
        <div className="flex items-start gap-2 font-mono text-xs">
          <span className="text-slate-400 select-none">Truy vấn:</span>
          <span className="text-amber-300 font-semibold break-all flex-1">{query}</span>
        </div>

        {result?.output && (
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Kết quả:</span>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-sky-400 hover:text-sky-300 transition-colors"
              >
                {expanded ? "Thu gọn ▲" : "Xem toàn bộ ▼"}
              </button>
            </div>
            <pre className="p-2.5 rounded bg-black/40 border border-white/5 text-[11px] text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-56">
              {expanded ? result.output : result.output.slice(0, 300) + (result.output.length > 300 ? "\n..." : "")}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
