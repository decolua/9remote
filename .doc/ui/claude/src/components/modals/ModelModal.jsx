// test-claude-web/src/components/modals/ModelModal.jsx
import React, { useState } from "react";

const MODELS = [
  { id: "sonnet", name: "Claude Sonnet 3.7", desc: "Mặc định: Cân bằng tuyệt vời giữa tốc độ và tư duy lập trình" },
  { id: "opus", name: "Claude Opus", desc: "Mô hình mạnh nhất cho kiến trúc phức tạp và lập luận khó" },
  { id: "haiku", name: "Claude Haiku", desc: "Siêu nhanh, phản hồi tức thì cho các tác vụ ngắn" },
  { id: "fable", name: "Claude Fable", desc: "Mô hình thế hệ mới tối ưu tốc độ" },
  { id: "sonnet[1m]", name: "Claude Sonnet [1M Context]", desc: "Mở rộng cửa sổ ngữ cảnh lên tới 1 triệu token" },
  { id: "opus[1m]", name: "Claude Opus [1M Context]", desc: "Opus với bộ nhớ siêu dài 1 triệu token" },
  { id: "best", name: "Best (Tốt nhất)", desc: "Hệ thống tự động chọn mô hình tối ưu nhất" },
];

const EFFORTS = [
  { id: "low", label: "Low (Thấp)", desc: "Phản hồi nhanh nhất, suy nghĩ ngắn" },
  { id: "medium", label: "Medium (Vừa)", desc: "Mức cân bằng mặc định" },
  { id: "high", label: "High (Cao)", desc: "Suy nghĩ kỹ trước khi đưa ra giải pháp" },
  { id: "xhigh", label: "Extra High (Rất cao)", desc: "Lập luận sâu cho bài toán khó" },
  { id: "max", label: "Max (Tối đa)", desc: "Sử dụng tối đa ngân sách suy nghĩ" },
];

export function ModelModal({ currentModel, onClose, onApply }) {
  const [selectedModel, setSelectedModel] = useState(currentModel || "sonnet");
  const [selectedEffort, setSelectedEffort] = useState("medium");

  const handleSubmit = (e) => {
    e.preventDefault();
    onApply(selectedModel, selectedEffort);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🤖</span>
            <h2 className="text-sm font-semibold text-white">Chọn Model & Mức suy nghĩ (/model)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-5 flex-1 overflow-y-auto flex flex-col gap-5">
          {/* Models */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              1. Mô hình AI (Model)
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {MODELS.map((m) => (
                <label
                  key={m.id}
                  className={`p-3 rounded-xl border flex items-start gap-3 cursor-pointer transition-all ${
                    selectedModel === m.id
                      ? "bg-blue-600/20 border-blue-500/60 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={selectedModel === m.id}
                    onChange={() => setSelectedModel(m.id)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-semibold flex items-center justify-between">
                      <span>{m.name}</span>
                      <span className="font-mono text-[10px] text-slate-400 opacity-80">{m.id}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{m.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Effort */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              2. Mức độ suy nghĩ (/effort)
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {EFFORTS.map((ef) => (
                <label
                  key={ef.id}
                  className={`p-2.5 rounded-xl border flex items-center gap-3 cursor-pointer transition-all ${
                    selectedEffort === ef.id
                      ? "bg-purple-600/20 border-purple-500/60 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="effort"
                    value={ef.id}
                    checked={selectedEffort === ef.id}
                    onChange={() => setSelectedEffort(ef.id)}
                    className="accent-purple-500"
                  />
                  <div className="flex-1 flex items-center justify-between">
                    <span className="text-xs font-semibold">{ef.label}</span>
                    <span className="text-[11px] text-slate-400">{ef.desc}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Buttons */}
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
              className="px-5 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-500/20 transition-all"
            >
              Áp dụng thay đổi
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
