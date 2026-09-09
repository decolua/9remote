// test-claude-web/src/components/TaskBar.jsx
import React, { useState } from "react";

export function TaskBar({ tasks = new Map(), isPlanMode = false }) {
  const [expanded, setExpanded] = useState(false);
  const list = Array.from(tasks.values());

  if (list.length === 0 && !isPlanMode) return null;

  const inProgress = list.find((t) => t.status === "in_progress");
  const completed = list.filter((t) => t.status === "completed").length;

  return (
    <div className="flex-shrink-0">
      {isPlanMode && (
        <div className="bg-purple-950/40 border-b border-purple-500/30 px-5 py-1.5 text-xs text-purple-300 font-medium flex items-center gap-2">
          <span>📋</span>
          <span>Claude đang ở Chế độ Lập Kế Hoạch (Plan Mode) — Các thao tác sửa file tạm thời khóa cho tới khi duyệt kế hoạch.</span>
        </div>
      )}

      {list.length > 0 && (
        <div className="bg-slate-900/80 border-b border-white/5 px-5 py-2 text-xs flex items-center justify-between text-slate-300">
          <div className="flex items-center gap-3">
            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded font-mono font-semibold text-[11px]">
              TASKS ({completed}/{list.length})
            </span>
            <span className="font-medium text-slate-200">
              {inProgress ? (
                <span className="text-sky-400 flex items-center gap-1.5">
                  <span className="animate-spin inline-block">🔄</span> {inProgress.activeForm || inProgress.subject}
                </span>
              ) : (
                `Đã hoàn thành ${completed}/${list.length} công việc`
              )}
            </span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-slate-400 hover:text-white transition-colors"
          >
            {expanded ? "Thu gọn ▲" : "Chi tiết ▼"}
          </button>
        </div>
      )}

      {expanded && list.length > 0 && (
        <div className="bg-black/50 border-b border-white/5 px-5 py-3 max-h-48 overflow-y-auto flex flex-col gap-1.5 text-xs">
          {list.map((t, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span>{t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳"}</span>
              <span className={t.status === "completed" ? "line-through text-slate-500" : t.status === "in_progress" ? "text-sky-300 font-semibold" : "text-slate-300"}>
                {t.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
