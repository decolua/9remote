// test-claude-web/src/components/modals/TasksModal.jsx
import React from "react";

export function TasksModal({ tasks = new Map(), onClose, onClearTasks }) {
  const taskList = Array.from(tasks.values());
  const completed = taskList.filter((t) => t.status === "completed").length;
  const inProgress = taskList.filter((t) => t.status === "in_progress").length;
  const pending = taskList.filter((t) => t.status === "pending").length;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📋</span>
            <h2 className="text-sm font-semibold text-white">Quản lý tác vụ (/tasks)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        {/* Overview Stats */}
        <div className="px-5 py-3 bg-white/5 border-b border-white/10 grid grid-cols-4 gap-2 text-center text-xs font-mono">
          <div className="p-2 rounded bg-black/30">
            <div className="text-slate-400 text-[10px]">TỔNG SỐ</div>
            <div className="text-base font-bold text-white">{taskList.length}</div>
          </div>
          <div className="p-2 rounded bg-black/30">
            <div className="text-sky-400 text-[10px]">ĐANG CHẠY</div>
            <div className="text-base font-bold text-sky-400">{inProgress}</div>
          </div>
          <div className="p-2 rounded bg-black/30">
            <div className="text-emerald-400 text-[10px]">HOÀN THÀNH</div>
            <div className="text-base font-bold text-emerald-400">{completed}</div>
          </div>
          <div className="p-2 rounded bg-black/30">
            <div className="text-slate-400 text-[10px]">ĐANG CHỜ</div>
            <div className="text-base font-bold text-slate-300">{pending}</div>
          </div>
        </div>

        {/* Task List */}
        <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-2">
          {taskList.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-500">
              Hiện chưa có tác vụ nào được tạo trong phiên này.
            </div>
          ) : (
            taskList.map((t, idx) => (
              <div
                key={idx}
                className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-base">
                    {t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳"}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={`text-xs font-medium truncate ${
                        t.status === "completed"
                          ? "line-through text-slate-500"
                          : t.status === "in_progress"
                          ? "text-sky-300 font-semibold"
                          : "text-slate-200"
                      }`}
                    >
                      {t.subject}
                    </div>
                    {t.activeForm && t.status === "in_progress" && (
                      <div className="text-[11px] text-sky-400/80 font-mono mt-0.5 truncate">
                        {t.activeForm}
                      </div>
                    )}
                  </div>
                </div>

                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono flex-shrink-0 ${
                    t.status === "completed"
                      ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                      : t.status === "in_progress"
                      ? "bg-sky-500/15 text-sky-300 border border-sky-500/30 animate-pulse"
                      : "bg-white/5 text-slate-400 border border-white/10"
                  }`}
                >
                  {t.status}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex items-center justify-between">
          <button
            onClick={onClearTasks}
            className="px-3 py-1.5 rounded-xl text-xs text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors"
          >
            Xóa danh sách task
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-white bg-blue-600 hover:bg-blue-500 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
