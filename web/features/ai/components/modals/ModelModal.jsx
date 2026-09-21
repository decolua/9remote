"use client";

import { memo, useMemo, useState } from "react";
import { Bot, Check, Search } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

function formatContext(tokens) {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1000000) return `${Math.round(tokens / 100000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

function getProvider(m) {
  if (m.provider) return m.provider;
  if (m.id && m.id.includes("/")) return m.id.split("/")[0];
  return "";
}

function providerDisplayName(p) {
  if (p === "opencode") return "OpenCode Zen";
  if (p === "opencode-go") return "OpenCode Go";
  if (p === "anthropic") return "Anthropic";
  if (p === "openai") return "OpenAI";
  if (p === "google") return "Google";
  return p ? p.toUpperCase() : "Models";
}

export const ModelModal = memo(function ModelModal({
  currentModel = "",
  currentEffort = "",
  models = [],
  onClose,
  onSelectModel,
  onSelectEffort,
  isTurnRunning = false
}) {
  const [query, setQuery] = useState("");
  const [pendingModel, setPendingModel] = useState(currentModel);

  const modelList = useMemo(() => {
    const list = [...(models || [])];
    if (currentModel && !list.some((m) => m.id === currentModel)) {
      list.unshift({ id: currentModel, label: currentModel, desc: "Active CLI model", recent: true });
    }
    return list;
  }, [models, currentModel]);

  const active = modelList.find((m) => m.id === pendingModel);
  const efforts = active?.efforts || [];

  const handlePick = (modelId) => {
    vibrate();
    onSelectModel?.(modelId);
    setPendingModel(modelId);
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

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return modelList;
    return modelList.filter((m) => {
      const label = (m.label || "").toLowerCase();
      const id = (m.id || "").toLowerCase();
      const desc = (m.desc || "").toLowerCase();
      const provider = getProvider(m).toLowerCase();
      return label.includes(q) || id.includes(q) || desc.includes(q) || provider.includes(q);
    });
  }, [modelList, query]);

  // Section grouping matching OpenCode TUI:
  // 1. Recent (at top)
  // 2. OpenCode Go (excluding Recent items)
  // 3. OpenCode Zen (excluding Recent items)
  // 4. Other providers (if any)
  const groupedSections = useMemo(() => {
    const q = query.trim();
    if (q) {
      return [{ key: "search", title: "Search Results", items: filteredModels }];
    }

    const sections = [];
    const recentItems = modelList
      .filter((m) => m.recent || m.id === currentModel)
      .sort((a, b) => (a.recentRank ?? 999) - (b.recentRank ?? 999));

    if (recentItems.length > 0) {
      sections.push({
        key: "recent",
        title: "Recent",
        items: recentItems
      });
    }

    const recentIdSet = new Set(recentItems.map((m) => m.id));
    const nonRecent = modelList.filter((m) => !recentIdSet.has(m.id));

    // OpenCode Go models
    const goItems = nonRecent.filter((m) => getProvider(m) === "opencode-go");
    if (goItems.length > 0) {
      sections.push({
        key: "opencode-go",
        title: "OpenCode Go",
        items: goItems
      });
    }

    // OpenCode Zen models
    const zenItems = nonRecent.filter((m) => getProvider(m) === "opencode");
    if (zenItems.length > 0) {
      sections.push({
        key: "opencode",
        title: "OpenCode Zen",
        items: zenItems
      });
    }

    // Any other providers
    const otherItems = nonRecent.filter((m) => {
      const p = getProvider(m);
      return p !== "opencode-go" && p !== "opencode";
    });
    if (otherItems.length > 0) {
      sections.push({
        key: "other",
        title: "Other Models",
        items: otherItems
      });
    }

    return sections;
  }, [modelList, filteredModels, query, currentModel]);

  return (
    <ModalShell
      icon={<Bot size={14} />}
      title="Switch AI Model"
      subtitle="Select an active model for this session"
      maxWidth="max-w-md"
      onClose={onClose}
    >
      {/* Search Input */}
      <div className="px-4 py-2.5 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2 focus-within:text-text text-text-muted">
          <Search size={14} className="shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models..."
            className="w-full bg-transparent text-xs text-text placeholder-text-muted/70 focus:outline-none"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-text-muted hover:text-text shrink-0 text-xs px-1"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Reasoning tiers for the selected model */}
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
        {filteredModels.length === 0 ? (
          <div className="py-8 text-center text-xs text-text-muted">
            No models found matching "{query}"
          </div>
        ) : (
          groupedSections.map((sec) => (
            <div key={sec.key} className="flex flex-col gap-0.5 mb-2">
              {groupedSections.length > 1 && (
                <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted px-2 pt-2 pb-1 select-none flex items-center justify-between">
                  <span>{sec.title}</span>
                  <span className="text-text-subtle text-[9px]">{sec.items.length}</span>
                </div>
              )}
              {sec.items.map((m) => {
                const isSelected = pendingModel === m.id;
                const provider = getProvider(m);
                const isZen = provider === "opencode";
                const ctxStr = formatContext(m.contextWindow);

                return (
                  <div
                    key={`${sec.key}-${m.id}`}
                    onClick={isTurnRunning ? undefined : () => handlePick(m.id)}
                    data-selected={isSelected}
                    className={`modal-row ${isTurnRunning ? "opacity-40 cursor-not-allowed pointer-events-none" : ""}`}
                    title={isTurnRunning ? "Cannot change model while turn is running" : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-text flex items-center gap-1.5 flex-wrap">
                        <span className="truncate">{m.label || m.id}</span>
                        {isZen && (
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono shrink-0">
                            Free
                          </span>
                        )}
                        {ctxStr && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-surface-2/60 text-text-subtle font-mono shrink-0">
                            {ctxStr}
                          </span>
                        )}
                        {m.efforts?.length > 0 && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-brand-500/10 text-brand-400 font-mono shrink-0">
                            reasoning
                          </span>
                        )}
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
          ))
        )}
      </div>
    </ModalShell>
  );
});
