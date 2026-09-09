// test-claude-web/src/components/tools/PlanModeCard.jsx
import React from "react";

export function PlanModeCard({ toolName, input = {}, result }) {
  const isEnter = toolName === "EnterPlanMode";
  const reason = input.reason || (isEnter ? "Đang phân tích codebase và thiết kế giải pháp" : "Kế hoạch đã sẵn sàng");

  return (
    <div className={`p-4 rounded-xl border flex flex-col gap-2 my-1 ${
      isEnter
        ? "bg-purple-950/25 border-purple-500/40 text-purple-200"
        : "bg-emerald-950/25 border-emerald-500/40 text-emerald-200"
    }`}>
      <div className="flex items-center justify-between text-xs font-semibold">
        <div className="flex items-center gap-2">
          <span className="text-base">{isEnter ? "📋" : "🚀"}</span>
          <span>{isEnter ? "Bắt đầu Chế độ Lập Kế Hoạch (Plan Mode)" : "Kế hoạch đã hoàn thành (Exit Plan Mode)"}</span>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/10">
          {toolName}
        </span>
      </div>

      <div className="text-xs text-slate-300 leading-relaxed font-sans pl-6">
        <span className="text-slate-400">Lý do: </span>
        {reason}
      </div>

      {isEnter && (
        <div className="text-[11px] text-purple-300/80 italic pl-6 select-none">
          ℹ️ Trong chế độ Plan Mode, Claude chỉ đọc file và thiết kế phương án. Code sẽ không bị sửa đổi trước khi bạn duyệt.
        </div>
      )}
    </div>
  );
}
