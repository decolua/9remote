// test-claude-web/src/components/Header.jsx
import React from "react";

export function Header({
  status,
  viewMode,
  onViewChange,
  permissionMode,
  onModeChange,
  onReset,
  onOpenModal,
}) {
  const isBusy = status === "busy";

  return (
    <header className="h-14 px-4 bg-slate-900/90 backdrop-blur-md border-b border-white/10 flex items-center justify-between z-50 flex-shrink-0 gap-3">
      {/* Brand & Status */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center font-bold text-sm text-white shadow-lg shadow-blue-500/20 flex-shrink-0">
          C
        </div>
        <div>
          <div className="font-semibold text-sm tracking-tight text-white flex items-center gap-2">
            Claude Code
            <span className="text-[10px] text-slate-400 border border-white/10 px-1.5 py-0.5 rounded font-mono">
              Harness
            </span>
          </div>
        </div>
        <div className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full border flex items-center gap-1.5 ${
          isBusy
            ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
            : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isBusy ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
          {isBusy ? "Đang xử lý..." : "Sẵn sàng"}
        </div>
      </div>

      {/* Center View Mode Switcher */}
      <div className="flex items-center bg-black/40 p-1 rounded-lg border border-white/10">
        <button
          onClick={() => onViewChange("ui")}
          className={`px-3 py-1 rounded text-xs font-semibold transition-all flex items-center gap-1.5 ${
            viewMode === "ui"
              ? "bg-blue-600 text-white shadow-sm shadow-blue-500/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          💬 Chat UI
        </button>
        <button
          onClick={() => onViewChange("split")}
          className={`px-3 py-1 rounded text-xs font-semibold transition-all flex items-center gap-1.5 ${
            viewMode === "split"
              ? "bg-blue-600 text-white shadow-sm shadow-blue-500/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          ⚡ Chia đôi
        </button>
        <button
          onClick={() => onViewChange("terminal")}
          className={`px-3 py-1 rounded text-xs font-semibold transition-all flex items-center gap-1.5 ${
            viewMode === "terminal"
              ? "bg-blue-600 text-white shadow-sm shadow-blue-500/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          🖥️ Terminal (Ctrl+~)
        </button>
      </div>

      {/* Quick Menu Tools & Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onOpenModal && onOpenModal("tasks")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Xem tác vụ (/tasks)"
        >
          <span>📋</span>
          <span className="hidden sm:inline">Tasks</span>
        </button>

        <button
          onClick={() => onOpenModal && onOpenModal("doctor")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Kiểm tra hệ thống (/doctor)"
        >
          <span>🩺</span>
          <span className="hidden sm:inline">Doctor</span>
        </button>

        <button
          onClick={() => onOpenModal && onOpenModal("model")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Đổi Model (/model)"
        >
          <span>🤖</span>
          <span className="hidden sm:inline">Model</span>
        </button>

        <button
          onClick={() => onOpenModal && onOpenModal("config")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Cài đặt hệ thống (/config)"
        >
          <span>⚙️</span>
          <span className="hidden sm:inline">Cài đặt</span>
        </button>

        <button
          onClick={() => onOpenModal && onOpenModal("mcp")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Quản lý MCP (/mcp)"
        >
          <span>🔌</span>
          <span className="hidden sm:inline">MCP</span>
        </button>

        <button
          onClick={() => onOpenModal && onOpenModal("resume")}
          className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all flex items-center gap-1"
          title="Lịch sử phiên (/resume)"
        >
          <span>📂</span>
          <span className="hidden sm:inline">Phiên cũ</span>
        </button>

        <select
          value={permissionMode}
          onChange={(e) => onModeChange(e.target.value)}
          className="bg-white/5 border border-white/10 text-slate-300 text-xs rounded-md px-2 py-1 outline-none font-sans"
        >
          <option value="default">Quyền: Mặc định</option>
          <option value="acceptEdits">Quyền: Tự duyệt sửa file</option>
          <option value="auto">Quyền: Tự động (Auto)</option>
          <option value="bypassPermissions">Quyền: Bỏ qua (Bypass)</option>
          <option value="plan">Quyền: Plan mode</option>
        </select>

        <button
          onClick={onReset}
          className="px-2.5 py-1 bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-medium rounded-md transition-all"
          title="Tạo phiên mới (/clear)"
        >
          🔄 Mới
        </button>
      </div>
    </header>
  );
}
