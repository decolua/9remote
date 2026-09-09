// test-codex-web/src/components/modals/ModelModal.jsx
import React, { useState } from "react";

const CODEX_MODELS = [
  { id: "ag/gemini-3.8-flash-high", name: "Gemini 3.8 Flash (9router)", desc: "Mô hình mặc định tốc độ cao qua proxy 9router" },
  { id: "gpt-5.6-sol", name: "OpenAI GPT-5.6 Sol", desc: "Mô hình lập trình mạnh mẽ nhất của OpenAI dành cho Codex" },
  { id: "o3", name: "OpenAI o3", desc: "Mô hình suy luận sâu cho bài toán thuật toán và kiến trúc" },
  { id: "o4-mini", name: "OpenAI o4-mini", desc: "Nhanh, nhẹ và tiết kiệm token" },
];

const EFFORTS = [
  { id: "low", label: "Low (Thấp)", desc: "Suy luận ngắn, trả lời tức thì" },
  { id: "medium", label: "Medium (Vừa)", desc: "Mức cân bằng mặc định" },
  { id: "high", label: "High (Cao)", desc: "Suy luận sâu trước khi viết code" },
];

export function ModelModal({ currentModel, onClose, onApply }) {
  const [selectedModel, setSelectedModel] = useState(currentModel || "ag/gemini-3.8-flash-high");
  const [selectedEffort, setSelectedEffort] = useState("medium");

  const handleSubmit = (e) => {
    e.preventDefault();
    onApply(selectedModel, selectedEffort);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🤖</span>
            <h2 className="text-sm font-semibold text-white">Chọn Model & Mức suy luận Codex (/model)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex-1 overflow-y-auto flex flex-col gap-5">
          {/* Models */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              1. Mô hình Codex (Model)
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {CODEX_MODELS.map((m) => (
                <label
                  key={m.id}
                  className={`p-3 rounded-xl border flex items-start gap-3 cursor-pointer transition-all ${
                    selectedModel === m.id
                      ? "bg-emerald-600/20 border-emerald-500/60 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={selectedModel === m.id}
                    onChange={() => setSelectedModel(m.id)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-semibold flex items-center justify-between">
                      <span>{m.name}</span>
                      <span className="font-mono text-[10px] text-slate-400 opacity-80 truncate max-w-[120px]">{m.id}</span>
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
              2. Mức độ suy luận (/effort)
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
              Áp dụng thay đổi
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
