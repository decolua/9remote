"use client";

import { Globe, Search } from "@/shared/components/ui/Icon";

// Address-bar suggestions (orca BrowserAddressBarSuggestionList shape): a
// search-fallback row first, then history — icon by kind, title + muted url.
export default function BrowserAddressSuggestions({ items, activeIdx, onPick, onHover }) {
  if (!items?.length) return null;
  return (
    <div className="absolute left-0 right-0 top-full mt-1 z-30 menu-popover p-1 max-h-64 overflow-y-auto shadow-xl animate-in fade-in duration-75">
      {items.map((h, i) => (
        <button
          key={h.url}
          type="button"
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onPick(h)}
          className={`w-full text-left px-3 py-2 rounded-[6px] flex items-center gap-2 ${
            i === activeIdx ? "bg-surface-2" : "hover:bg-surface-2/60"
          }`}
        >
          {h.isSearch
            ? <Search size={14} className="shrink-0 text-text-muted" />
            : <Globe size={14} className="shrink-0 text-text-muted" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-text">{h.title}</span>
            {h.subtitle && <span className="truncate text-xs text-text-muted font-mono">{h.subtitle}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
