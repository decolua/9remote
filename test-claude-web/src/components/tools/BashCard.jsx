// test-claude-web/src/components/tools/BashCard.jsx
import React from "react";

export function BashCard({ input, result, id }) {
  const isError = result?.isError;
  const output = result?.output || "Đang thực thi lệnh...";

  return (
    <div className="tool-card bash-card">
      <div className="tool-card-header bash-header">
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
        {result && (
          <span className={`status-badge text-[11px] ${isError ? "text-rose-400" : "text-emerald-400"}`}>
            {isError ? "✗ Thất bại" : "✓ Xong"}
          </span>
        )}
      </div>
      <div className="p-3 font-mono text-xs">
        <div className="text-amber-300 font-medium break-all">
          $ {input.command || ""}
        </div>
        {input.description && (
          <div className="text-slate-500 text-[11px] mt-1 italic">
            # {input.description}
          </div>
        )}
        <div className={`mt-2 p-2.5 rounded bg-black/40 border border-white/5 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed ${isError ? "text-rose-300" : "text-slate-300"}`}>
          {output}
        </div>
      </div>
    </div>
  );
}
