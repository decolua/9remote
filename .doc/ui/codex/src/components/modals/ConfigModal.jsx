// test-codex-web/src/components/modals/ConfigModal.jsx
import React, { useState } from "react";

export function ConfigModal({ currentSandbox = "workspace-write", onClose, onApply }) {
  const [sandbox, setSandbox] = useState(currentSandbox);
  const [webSearch, setWebSearch] = useState(true);

  const handleSubmit = (e) => {
    e.preventDefault();
    onApply({ sandbox, webSearch });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚙️</span>
            <h2 className="text-sm font-semibold text-white">Cấu hình Codex (/config)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            {/* Sandbox selection */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
                Chế độ Sandbox (-s)
              </label>
              <select
                value={sandbox}
                onChange={(e) => setSandbox(e.target.value)}
                className="p-2.5 rounded-xl bg-black/40 border border-white/10 text-xs text-slate-200 outline-none focus:border-emerald-500"
              >
                <option value="workspace-write">workspace-write (Chỉ sửa file trong dự án)</option>
                <option value="read-only">read-only (Chỉ đọc, không cho sửa file)</option>
                <option value="danger-full-access">danger-full-access (Toàn quyền hệ thống)</option>
              </select>
            </div>

            {/* Web Search */}
            <label className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
              <div>
                <div className="text-xs font-semibold text-white">Bật tìm kiếm web (--search)</div>
                <div className="text-[11px] text-slate-400">Cho phép Codex tra cứu tài liệu trên internet</div>
              </div>
              <input
                type="checkbox"
                checked={webSearch}
                onChange={(e) => setWebSearch(e.target.checked)}
                className="w-4 h-4 accent-emerald-500 rounded"
              />
            </label>
          </div>

          <div className="pt-3 border-t border-white/10 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-slate-300 hover:bg-white/10 transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 shadow-md shadow-emerald-500/20 transition-all"
            >
              Lưu cấu hình
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
