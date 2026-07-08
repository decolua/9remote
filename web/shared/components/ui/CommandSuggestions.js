"use client";

import { useMemo, useState } from "react";
import { History, Pin, Terminal, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// Per-type row quotas (desktop / mobile). Unfilled quota is lent to other types
// up to the total cap, so short queries still surface a full, useful list.
const QUOTA = {
  desktop: { pinned: 2, history: 4, common: 4, total: 8 },
  mobile: { pinned: 1, history: 2, common: 2, total: 4 }
};

// Rank a match: prefix hits beat mid-string hits; shorter commands come first so
// a short query surfaces the base command, longer variants appear as you type more.
const scoreOf = (key, q) => {
  const idx = key.indexOf(q);
  if (idx < 0) return null;
  const prefix = idx === 0 ? 0 : 1000; // prefix matches rank above substring
  return prefix + idx + key.length * 0.1;
};

// Inline command suggestions floating above an input. Ranks pinned snippets,
// history and (optional) common commands by relevance to the typed text.
// Absolute + translucent blurred background so it overlays content, not push it.
export default function CommandSuggestions({ value, store, commonCommands = [], onSelect, isMobile = false }) {
  const history = store((s) => s.history);
  const pinned = store((s) => s.pinned);
  // Dismiss the panel for the current text; typing more re-opens it.
  const [dismissed, setDismissed] = useState("");

  const items = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];

    const seen = new Set();
    const collect = (list, type, getCmd) => {
      const out = [];
      for (const entry of list) {
        const cmd = getCmd(entry);
        const key = cmd.toLowerCase();
        if (!cmd || key === q || seen.has(key)) continue;
        const score = scoreOf(key, q);
        if (score === null) continue;
        seen.add(key);
        out.push({ cmd, type, score });
      }
      return out.sort((a, b) => a.score - b.score);
    };

    // Order matters: pinned first claims dedup priority, then history, then common.
    const groups = {
      pinned: collect(pinned, "pinned", (s) => s.cmd),
      history: collect(history, "history", (c) => c),
      common: collect(commonCommands, "common", (c) => c)
    };

    const quota = isMobile ? QUOTA.mobile : QUOTA.desktop;
    const picked = [
      ...groups.pinned.slice(0, quota.pinned),
      ...groups.history.slice(0, quota.history),
      ...groups.common.slice(0, quota.common)
    ];
    // Lend leftover slots (up to total cap) to whatever else matched, best-ranked first.
    if (picked.length < quota.total) {
      const chosen = new Set(picked.map((i) => i.cmd));
      const rest = [...groups.pinned, ...groups.history, ...groups.common]
        .filter((i) => !chosen.has(i.cmd))
        .sort((a, b) => a.score - b.score)
        .slice(0, quota.total - picked.length);
      picked.push(...rest);
    }
    return picked.slice(0, quota.total);
  }, [value, history, pinned, commonCommands, isMobile]);

  if (items.length === 0 || dismissed === value) return null;

  const iconOf = (type) =>
    type === "pinned" ? <Pin size={13} className="text-brand-500" fill="currentColor" />
      : type === "common" ? <Terminal size={13} className="text-text-muted" />
        : <History size={13} className="text-text-muted" />;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-40 rounded-brand overflow-hidden bg-surface-1/95 backdrop-blur-xl shadow-xl ring-1 ring-border">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setDismissed(value)}
        className="absolute right-1 top-1 z-10 w-5 h-5 flex items-center justify-center rounded-full bg-surface-2/80 text-text-muted hover:text-text transition-colors"
        aria-label="Close"
      >
        <X size={12} />
      </button>
      <div className="flex flex-col max-h-[25vh] overflow-y-auto modal-scrollable">
        {items.map((it) => (
          <button
            key={`${it.type}-${it.cmd}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { vibrate(); onSelect(it.cmd); }}
            className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="flex-shrink-0">{iconOf(it.type)}</span>
            <span className="min-w-0 text-sm text-text font-mono truncate">{it.cmd}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
