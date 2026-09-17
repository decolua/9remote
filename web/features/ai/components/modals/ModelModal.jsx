"use client";

import { memo, useMemo, useState } from "react";
import { Bot, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

export const ModelModal = memo(function ModelModal({
  currentModel = "",
  currentEffort = "",
  models = [],
  onClose,
  onSelectModel,
  onSelectEffort,
  isTurnRunning = false
}) {
  // The model whose tiers the effort row lists. Defaults to the running model, but a
  // pick moves it — the tiers belong to whatever model is about to run.
  const [pendingModel, setPendingModel] = useState(currentModel);
  const modelList = useMemo(() => {
    const list = [...(models || [])];
    // The running model may not be in the host's list — set from another surface, or
    // the CLI picked it on its own. Show it so the active one is never missing.
    if (currentModel && !list.some((m) => m.id === currentModel)) {
      list.unshift({ id: currentModel, label: currentModel, desc: "Active CLI model" });
    }
    return list;
  }, [models, currentModel]);

  // Tiers come from the host catalog; an engine with none offers no effort row.
  const active = modelList.find((m) => m.id === pendingModel);
  const efforts = active?.efforts || [];

  const handlePick = (modelId) => {
    vibrate();
    onSelectModel?.(modelId);
    setPendingModel(modelId);
    // Validate against the tiers of the model being picked, not the one on screen —
    // the tiers differ per model, and a level the new model rejects (luna's `max` on
    // 5.5) would otherwise stay selected and fail the next turn.
    const next = modelList.find((m) => m.id === modelId);
    const nextEfforts = next?.efforts || [];
    if (nextEfforts.length > 0 && !nextEfforts.includes(currentEffort)) {
      const fallback = next?.defaultEffort || nextEfforts[0];
      if (fallback) onSelectEffort?.(fallback);
    }
  };

  const handlePickEffort = (effort) => {
    vibrate();
    onSelectEffort?.(effort);
  };

  return (
    <ModalShell
      icon={<Bot size={14} />}
      title="Switch AI Model"
      subtitle="Select an active model for this session"
      maxWidth="max-w-md"
      onClose={onClose}
    >
      {/* Reasoning tiers for the selected model. Picking one applies immediately, the
          way the CLI's own /model does — the list stays open so a model can follow. */}
      {efforts.length > 0 && (
        <div className="px-3 pt-3 shrink-0">
          <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
            Reasoning effort
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {efforts.map((effort) => (
              <button
                key={effort}
                type="button"
                disabled={isTurnRunning}
                onClick={() => handlePickEffort(effort)}
                className={`px-2.5 py-1 rounded-brand text-[11px] font-mono border transition-colors ${
                  currentEffort === effort
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border-subtle bg-surface-2/30 text-text-muted hover:text-text hover:bg-surface-2"
                } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
                title={isTurnRunning ? "Cannot change effort while turn is running" : undefined}
              >
                {effort}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* List */}
      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
        {modelList.map((m) => {
          const isSelected = pendingModel === m.id;
          return (
            <div
              key={m.id}
              onClick={isTurnRunning ? undefined : () => handlePick(m.id)}
              data-selected={isSelected}
              className={`modal-row ${isTurnRunning ? "opacity-40 cursor-not-allowed pointer-events-none" : ""}`}
              title={isTurnRunning ? "Cannot change model while turn is running" : undefined}
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-text flex items-center gap-1.5">
                  <span className="truncate">{m.label}</span>
                </div>
                <div className="text-[10px] font-mono text-text-subtle truncate mt-0.5">
                  {m.desc || m.id}
                </div>
              </div>

              {isSelected && (
                <Check size={14} className="text-brand-500 shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
});
