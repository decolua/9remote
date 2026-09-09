// test-claude-web/src/components/tools/BashCard.jsx
import React, { useState } from "react";

export function BashCard({ input, result, id }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);

  const isError = result?.isError;
  const output = result?.output || (result ? "" : "Đang thực thi lệnh...");
  const lines = (output || "").split("\n");
  const isLong = lines.length > 15;

  const handleCopyCmd = () => {
    navigator.clipboard.writeText(input.command || "");
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyOut = () => {
    navigator.clipboard.writeText(output);
    setCopiedOut(true);
    setTimeout(() => setCopiedOut(false), 2000);
  };

  return (
    <div className="tool-card bash-card">
      <div className="tool-card-header bash-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="mac-dots">
            <span className="dot red" />
            <span className="dot yellow" />
            <span className="dot green" />
          </div>
          <span className="tool-title text-sky-400 font-mono text-xs font-semibold">
            ⚡ Bash Shell
          </span>
        </div>

        <div className="flex items-center gap-2 select-none">
          <button
            onClick={handleCopyCmd}
            className="text-[11px] font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
            title="Sao chép câu lệnh"
          >
            {copiedCmd ? "✓ Đã chép lệnh" : "📋 Chép lệnh"}
          </button>
          {result && (
            <span className={`status-badge text-[11px] font-mono font-semibold ${isError ? "text-rose-400" : "text-emerald-400"}`}>
              {isError ? "✗ Thất bại" : "✓ Hoàn thành"}
            </span>
          )}
        </div>
      </div>

      <div className="p-3 font-mono text-xs flex flex-col gap-1.5">
        <div className="text-amber-300 font-medium break-all flex items-start gap-1.5">
          <span className="text-slate-500 select-none">$</span>
          <span className="flex-1">{input.command || ""}</span>
        </div>

        {input.description && (
          <div className="text-slate-500 text-[11px] italic">
            # {input.description}
          </div>
        )}

        {output && (
          <div className="mt-1 relative group">
            <pre className={`p-2.5 rounded bg-black/50 border border-white/5 overflow-x-auto whitespace-pre-wrap leading-relaxed ${
              isError ? "text-rose-300" : "text-slate-300"
            } ${expanded || !isLong ? "max-h-96" : "max-h-36 overflow-y-hidden"}`}>
              {output}
            </pre>

            {/* Quick copy output button */}
            <button
              onClick={handleCopyOut}
              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 px-2 py-0.5 bg-white/10 hover:bg-white/20 rounded text-[10px] text-slate-300 transition-opacity"
            >
              {copiedOut ? "✓ Đã chép" : "📋 Chép log"}
            </button>
          </div>
        )}

        {isLong && (
          <div className="flex justify-end pt-1">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-sky-400 hover:text-sky-300 text-[11px] font-medium transition-colors"
            >
              {expanded ? "Thu gọn ▲" : `Xem đầy đủ ${lines.length} dòng log ▼`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
