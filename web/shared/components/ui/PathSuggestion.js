"use client";

import { Folder, FileText } from "lucide-react";
import { vibrate } from "@/shared/utils/vibration";

// Path suggestion dropdown: mirrors CommandSuggestions styling. Items carry a
// ready-to-insert full command string ("verb path/"). Click → onSelect(full).
export default function PathSuggestion({ items, onSelect }) {
  if (!items?.length) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-40 rounded-brand overflow-hidden bg-surface/95 backdrop-blur-xl shadow-xl ring-1 ring-border touch-none">
      <div className="flex flex-col max-h-[25vh] overflow-y-auto modal-scrollable">
        {items.map((it) => (
          <button
            key={`${it.type}-${it.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { vibrate(); onSelect(it.full); }}
            className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 transition-colors touch-none"
          >
            <span className="flex-shrink-0">
              {it.type === "folder"
                ? <Folder size={13} className="text-brand-500" fill="currentColor" />
                : <FileText size={13} className="text-text-muted" />}
            </span>
            <span className="min-w-0 text-xs text-text font-mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", unicodeBidi: "plaintext" }} title={it.full}>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
