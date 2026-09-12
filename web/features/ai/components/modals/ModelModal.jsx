"use client";

import { memo, useMemo } from "react";
import { Bot, Check, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export const ModelModal = memo(function ModelModal({
  currentModel = "",
  models = [],
  onClose,
  onSelectModel
}) {
  const modelList = useMemo(() => {
    const list = [...(models || [])];
    // The running model may not be in the host's list — set from another surface, or
    // the CLI picked it on its own. Show it so the active one is never missing.
    if (currentModel && !list.some((m) => m.id === currentModel)) {
      list.unshift({ id: currentModel, label: currentModel, desc: "Active CLI model" });
    }
    return list;
  }, [models, currentModel]);

  const handlePick = (modelId) => {
    vibrate();
    onSelectModel?.(modelId);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 select-none">
      <div className="bg-surface border border-border-subtle rounded-brand-lg w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-brand-500/15 text-brand-500 flex items-center justify-center">
              <Bot size={14} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text">Switch AI Model</h2>
              <p className="text-[11px] text-text-muted">Select an active model for this session</p>
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

        {/* List */}
        <div className="p-3 flex-1 overflow-y-auto space-y-1.5 custom-scrollbar">
          {modelList.map((m) => {
            const isSelected = currentModel === m.id;
            return (
              <div
                key={m.id}
                onClick={() => handlePick(m.id)}
                className={`p-3 rounded-brand border flex items-center justify-between cursor-pointer transition-colors ${
                  isSelected
                    ? "border-brand-500 bg-brand-500/10 text-text"
                    : "border-border-subtle bg-surface-2/30 hover:bg-surface-2 text-text-muted hover:text-text"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-text flex items-center gap-1.5">
                    <span className="truncate">{m.label}</span>
                  </div>
                  <div className="text-[10px] font-mono text-text-muted truncate mt-0.5">
                    {m.desc || m.id}
                  </div>
                </div>

                {isSelected && (
                  <Check size={14} className="text-brand-500 shrink-0 ml-2" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
