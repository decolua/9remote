// test-codex-web/src/components/modals/SkillsModal.jsx
import React, { useState } from "react";

export function SkillsModal({ skills = [], onClose, onSelectSkill }) {
  const [search, setSearch] = useState("");

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      (s.description || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <div>
              <h2 className="text-sm font-semibold text-white">Danh mục Kỹ Năng Codex ({skills.length} Skills)</h2>
              <p className="text-[11px] text-slate-400">Nạp từ thư mục ~/.codex/skills/ để mở rộng khả năng cho Codex</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        {/* Search Bar */}
        <div className="p-3 bg-white/5 border-b border-white/10">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm kiếm skill (ví dụ: cloudflare, agents, wrangler...)"
            className="w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        {/* Skills List */}
        <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-2.5">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-500">
              Không tìm thấy skill nào khớp với từ khóa "{search}".
            </div>
          ) : (
            filtered.map((skill) => (
              <div
                key={skill.id}
                className="p-3.5 rounded-xl bg-white/5 border border-white/10 hover:border-emerald-500/40 hover:bg-white/10 transition-all flex flex-col gap-1.5 group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-400 font-mono font-semibold text-xs">
                      /{skill.name}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      skill
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      onSelectSkill(skill.name);
                      onClose();
                    }}
                    className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-600/80 hover:bg-emerald-600 text-white shadow-sm transition-colors"
                  >
                    Dùng skill ▶
                  </button>
                </div>

                <div className="text-xs text-slate-300 leading-relaxed font-sans line-clamp-3">
                  {skill.description}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-slate-300 hover:bg-white/10 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
