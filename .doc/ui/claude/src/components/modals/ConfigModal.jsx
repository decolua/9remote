// test-claude-web/src/components/modals/ConfigModal.jsx
import React, { useState } from "react";

export function ConfigModal({ onClose, onApplyConfig }) {
  const [config, setConfig] = useState({
    autoCompact: true,
    thinking: true,
    verbose: false,
    editor: "normal",
    copyOnSelect: true,
  });

  const toggle = (key) => setConfig((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const cmdList = Object.entries(config).map(([k, v]) => `${k}=${v}`).join(" ");
    onApplyConfig(cmdList);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚙️</span>
            <h2 className="text-sm font-semibold text-white">Cấu hình hệ thống (/config)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-2.5">
            {/* Auto Compact */}
            <label className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
              <div>
                <div className="text-xs font-semibold text-white">Tự động nén ngữ cảnh (Auto-Compact)</div>
                <div className="text-[11px] text-slate-400">Tự tóm tắt hội thoại khi vượt ngưỡng token</div>
              </div>
              <input
                type="checkbox"
                checked={config.autoCompact}
                onChange={() => toggle("autoCompact")}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>

            {/* Thinking */}
            <label className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
              <div>
                <div className="text-xs font-semibold text-white">Hiện khối suy nghĩ (Thinking)</div>
                <div className="text-[11px] text-slate-400">Hiển thị quá trình tư duy chi tiết của AI</div>
              </div>
              <input
                type="checkbox"
                checked={config.thinking}
                onChange={() => toggle("thinking")}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>

            {/* Verbose */}
            <label className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
              <div>
                <div className="text-xs font-semibold text-white">Log chi tiết (Verbose)</div>
                <div className="text-[11px] text-slate-400">Xuất thông tin chi tiết mọi lượt gọi tool</div>
              </div>
              <input
                type="checkbox"
                checked={config.verbose}
                onChange={() => toggle("verbose")}
                className="w-4 h-4 accent-blue-500 rounded"
              />
            </label>

            {/* Editor mode */}
            <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Chế độ biên soạn (Editor)</div>
                <div className="text-[11px] text-slate-400">Chọn phong cách gõ phím</div>
              </div>
              <select
                value={config.editor}
                onChange={(e) => setConfig((prev) => ({ ...prev, editor: e.target.value }))}
                className="bg-black/40 border border-white/10 text-xs rounded-lg px-2.5 py-1 text-slate-200 outline-none"
              >
                <option value="normal">Normal (Mặc định)</option>
                <option value="vim">Vim Mode</option>
              </select>
            </div>
          </div>

          <div className="pt-3 border-t border-white/10 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-slate-300 hover:bg-white/10 transition-colors"
            >
              Đóng
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-500/20 transition-all"
            >
              Lưu cấu hình
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
