"use client";

import { memo, useState } from "react";
import { Zap, Search, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

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
    <ModalShell
      icon={<Zap size={14} />}
      title={`Agent Skills (${skills.length})`}
      subtitle="Skills loaded from ~/.claude/skills and project directory"
      onClose={onClose}
    >
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
      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
            <Zap size={32} className="opacity-50" />
            <span className="text-sm">
              {skills.length === 0 ? "No skills discovered on host agent." : `No skills matching "${query}".`}
            </span>
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id || s.name}
              onClick={() => handlePick(s)}
              className="modal-row items-start"
            >
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-text">
                  <span>/{s.name || s.id}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-text-muted font-normal">
                    skill
                  </span>
                </div>
                {s.description && (
                  <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                    {s.description}
                  </p>
                )}
              </div>
              <span className="modal-row-acts text-[11px] text-brand-500 items-center gap-1">
                <span>Use</span>
                <CornerDownLeft size={11} />
              </span>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
});
