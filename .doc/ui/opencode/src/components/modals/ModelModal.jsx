// test-opencode-web/src/components/modals/ModelModal.jsx
import React, { useState } from "react";

const OPENCODE_MODELS = [
  { id: "opencode/big-pickle", name: "Big Pickle (Mặc định)", desc: "Mô hình đa năng chính của OpenCode" },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning", desc: "Tốc độ xử lý siêu tốc, phản hồi tức thì" },
  { id: "opencode/mimo-v2.5-free", name: "Mimo v2.5", desc: "Mô hình miễn phí cho tác vụ cơ bản" },
  { id: "opencode/muse-spark-1.3-contributor-free", name: "Muse Spark 1.3", desc: "Mô hình thông minh cho lập trình và phân tích" },
  { id: "opencode/ling-3.0-flash-fin-free", name: "Ling 3.0 Flash", desc: "Mô hình phản hồi nhanh" },
];

const VARIANTS = [
  { id: "minimal", label: "Minimal (Tối thiểu)", desc: "Phản hồi nhanh nhất, suy luận ngắn" },
  { id: "medium", label: "Medium (Vừa)", desc: "Mức cân bằng mặc định" },
  { id: "high", label: "High (Cao)", desc: "Suy luận sâu cho bài toán phức tạp" },
  { id: "max", label: "Max (Tối đa)", desc: "Sử dụng tối đa ngân sách suy luận" },
];

export function ModelModal({ currentModel, onClose, onApply }) {
  const [selectedModel, setSelectedModel] = useState(currentModel || "opencode/big-pickle");
  const [selectedVariant, setSelectedVariant] = useState("medium");

  const handleSubmit = (e) => {
    e.preventDefault();
    onApply(selectedModel, selectedVariant);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🤖</span>
            <h2 className="text-sm font-semibold text-white">Chọn Model & Mức suy luận OpenCode (/model)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex-1 overflow-y-auto flex flex-col gap-5">
          {/* Models */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              1. Mô hình AI (Model)
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {OPENCODE_MODELS.map((m) => (
                <label
                  key={m.id}
                  className={`p-3 rounded-xl border flex items-start gap-3 cursor-pointer transition-all ${
                    selectedModel === m.id
                      ? "bg-amber-600/20 border-amber-500/60 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={selectedModel === m.id}
                    onChange={() => setSelectedModel(m.id)}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-semibold flex items-center justify-between">
                      <span>{m.name}</span>
                      <span className="font-mono text-[10px] text-slate-400 opacity-80">{m.id.replace("opencode/", "")}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{m.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Variant / Effort */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              2. Mức độ suy luận (/variant)
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {VARIANTS.map((v) => (
                <label
                  key={v.id}
                  className={`p-2.5 rounded-xl border flex items-center gap-3 cursor-pointer transition-all ${
                    selectedVariant === v.id
                      ? "bg-purple-600/20 border-purple-500/60 text-white"
                      : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={v.id}
                    checked={selectedVariant === v.id}
                    onChange={() => setSelectedVariant(v.id)}
                    className="accent-purple-500"
                  />
                  <div className="flex-1 flex items-center justify-between">
                    <span className="text-xs font-semibold">{v.label}</span>
                    <span className="text-[11px] text-slate-400">{v.desc}</span>
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
              className="px-5 py-2 rounded-xl text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 shadow-md shadow-amber-500/20 transition-all"
            >
              Áp dụng thay đổi
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
