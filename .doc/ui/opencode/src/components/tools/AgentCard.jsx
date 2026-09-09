// test-claude-web/src/components/tools/AgentCard.jsx
import React, { useState } from "react";

export function AgentCard({ toolName, input = {}, result }) {
  const [expanded, setExpanded] = useState(false);
  const isWorkflow = toolName === "Workflow";
  const subagentType = input.subagent_type || (isWorkflow ? "Workflow" : "general-purpose");
  const description = input.description || input.name || (isWorkflow ? "Quy trình làm việc đa tác vụ" : "Phân luồng tác vụ phụ");
  const prompt = input.prompt || input.script || "";
  const isError = result?.isError;
  const isFinished = Boolean(result);

  return (
    <div className="tool-card border-purple-500/20 bg-[#090b17]">
      <div className="tool-card-header bg-purple-950/20 border-b border-purple-500/20 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{isWorkflow ? "⚡" : "🤖"}</span>
          <span className="font-semibold text-xs text-purple-300">
            {isWorkflow ? "Workflow Runner" : "Subagent CLI"}
          </span>
          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-200 border border-purple-500/30">
            {subagentType}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isFinished ? (
            <span className={`text-[11px] font-mono font-semibold ${isError ? "text-rose-400" : "text-emerald-400"}`}>
              {isError ? "✗ Thất bại" : "✓ Hoàn thành"}
            </span>
          ) : (
            <span className="text-[11px] text-sky-400 font-mono flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
              Đang chạy...
            </span>
          )}
        </div>
      </div>

      <div className="p-3 text-xs flex flex-col gap-2">
        <div className="font-medium text-slate-200 flex items-center gap-1.5">
          <span className="text-slate-400">Mô tả:</span>
          <span>{description}</span>
        </div>

        {prompt && (
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
              <span>Nhiệm vụ agent:</span>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                {expanded ? "Thu gọn ▲" : "Xem chi tiết ▼"}
              </button>
            </div>
            <pre className="p-2.5 rounded bg-black/40 border border-white/5 text-[11px] text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48">
              {expanded ? prompt : prompt.slice(0, 150) + (prompt.length > 150 ? "\n..." : "")}
            </pre>
          </div>
        )}

        {result && (
          <div className="pt-2 border-t border-white/5 text-[11px] text-slate-400 font-mono">
            {typeof result.output === "string" ? result.output.slice(0, 200) : "Đã nhận kết quả từ subagent."}
          </div>
        )}
      </div>
    </div>
  );
}
