"use client";

import { memo, useState } from "react";
import { Zap, Search, X, Check, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export const SkillsModal = memo(function SkillsModal({
  skills = [],
  onClose,
  onSelectSkill
}) {
  const [query, setQuery] = useState("");

  const filtered = skills.filter((s) => {
    const q = query.toLowerCase();
    return (s.name || s.id || "").toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q);
  });

  const handlePick = (skill) => {
    vibrate();
    onSelectSkill?.(skill.name || skill.id);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 select-none">
      <div className="bg-surface border border-border-subtle rounded-brand-lg w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-brand-500/15 text-brand-500 flex items-center justify-center">
              <Zap size={14} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text">Agent Skills ({skills.length})</h2>
              <p className="text-[11px] text-text-muted">Skills loaded from ~/.claude/skills and project directory</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-border-subtle bg-bg">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-brand bg-surface border border-border-subtle focus-within:border-brand-500">
            <Search size={14} className="text-text-muted shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills (e.g. cloudflare, review, deploy)..."
              className="w-full bg-transparent text-xs text-text placeholder-text-muted focus:outline-none"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="p-3 flex-1 overflow-y-auto space-y-2 custom-scrollbar">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-xs text-text-muted">
              {skills.length === 0 ? "No skills discovered on host agent." : `No skills matching "${query}".`}
            </div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id || s.name}
                onClick={() => handlePick(s)}
                className="p-2.5 rounded-brand border border-border-subtle bg-surface-2/40 hover:bg-surface-2 hover:border-brand-500/40 transition-colors cursor-pointer flex flex-col gap-1 group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-text group-hover:text-brand-500 transition-colors">
                    <span>/{s.name || s.id}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-text-muted font-normal">
                      skill
                    </span>
                  </div>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 text-[11px] text-brand-500 flex items-center gap-1 transition-opacity"
                  >
                    <span>Use</span>
                    <CornerDownLeft size={11} />
                  </button>
                </div>
                {s.description && (
                  <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                    {s.description}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
