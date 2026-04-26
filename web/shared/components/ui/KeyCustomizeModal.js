"use client";

import { useEffect, useState } from "react";
import { X, Trash2, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

const KEY_BTN = "min-w-[38px] h-9 px-2 flex items-center justify-center rounded-brand text-xs font-semibold select-none shrink-0 whitespace-nowrap transition-all duration-150 ease-out active:scale-[0.96]";
const STYLE_NORMAL = "bg-surface-2 hover:bg-surface-3 text-text";
const STYLE_SELECTED = "bg-brand-500 text-white";
const STYLE_PLUS = "border border-dashed border-border text-text-subtle hover:text-text hover:bg-surface-2";
const ROW_CLASS = "modal-scrollable flex items-center gap-1.5 overflow-x-auto pb-1";

function KeyBtn({ label, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={() => { vibrate(); onClick(); }}
      className={`${KEY_BTN} ${selected ? STYLE_SELECTED : STYLE_NORMAL}`}
    >
      {label}
    </button>
  );
}

function PlusBtn({ selected, onClick }) {
  return (
    <button
      type="button"
      onClick={() => { vibrate(); onClick(); }}
      className={`${KEY_BTN} ${selected ? STYLE_SELECTED : STYLE_PLUS}`}
      title="Select this slot, then pick a key below"
    >
      <Plus size={16} />
    </button>
  );
}

// tabs: [{ id, label, hook }]
// Uses the hook's `mode` ("flat" | "grid") to choose layout automatically.
export default function KeyCustomizeModal({ isOpen, onClose, title = "Customize Keys", tabs }) {
  const [activeTab, setActiveTab] = useState(tabs?.[0]?.id);
  // selected target in Current: { row, col } — col === rowLen means "+" slot
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(null);
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [isOpen, onClose]);

  // Reset selection when switching tabs
  useEffect(() => { setSelected(null); }, [activeTab]);

  if (!isOpen) return null;

  const tab = tabs.find(t => t.id === activeTab) || tabs[0];
  const { rows: rawRows, available: rawAvailable, replaceAt, swap, removeAt, reset } = tab.hook;
  const excludeIds = tab.excludeIds || [];
  // Map each filtered row to its raw col indexes, so hook ops target correct slot.
  const rowMaps = rawRows.map(r => r.map((id, i) => ({ id, rawCol: i })).filter(x => !excludeIds.includes(x.id)));
  const rows = rowMaps.map(m => m.map(x => x.id));
  const available = excludeIds.length
    ? rawAvailable.filter(k => !excludeIds.includes(k.id))
    : rawAvailable;

  // Resolve filtered (row, col) → raw col. For "+" slot (col === row.length) → append (rawRows[r].length).
  const toRawCol = (r, c) => {
    const map = rowMaps[r] || [];
    if (c >= map.length) return (rawRows[r] || []).length;
    return map[c].rawCol;
  };

  const isSelected = (r, c) => selected && selected.row === r && selected.col === c;

  const handleCurrentClick = (row, col, isPlus) => {
    // Toggle deselect
    if (!isPlus && isSelected(row, col)) { setSelected(null); return; }
    // Swap two filled slots
    if (selected && !isPlus && !(selected.col >= rows[selected.row].length)) {
      swap(
        { row: selected.row, col: toRawCol(selected.row, selected.col) },
        { row, col: toRawCol(row, col) }
      );
      setSelected(null);
      return;
    }
    // Otherwise just set selection (plus slot or first click)
    setSelected({ row, col });
  };

  const handleAvailableClick = (id) => {
    if (!selected) {
      const targetRow = rows.length > 0 ? rows.length - 1 : 0;
      replaceAt(targetRow, (rawRows[targetRow] || []).length, id);
    } else {
      replaceAt(selected.row, toRawCol(selected.row, selected.col), id);
    }
    setSelected(null);
  };

  const handleRemove = () => {
    if (!selected) return;
    const row = rows[selected.row] || [];
    if (selected.col < row.length) removeAt(selected.row, toRawCol(selected.row, selected.col));
    setSelected(null);
  };

  const poolMap = new Map();
  tab.hook.keys?.forEach(k => poolMap.set(k.id, k));
  // build a combined label map including available (for rendering IDs→labels)
  available.forEach(k => poolMap.set(k.id, k));

  const hasRemovable = selected && rows[selected.row] && selected.col < rows[selected.row].length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative card-elev w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text">{title}</h3>
          <button onClick={() => { vibrate(); onClose(); }} className="text-text-muted hover:text-text">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        {tabs.length > 1 && (
          <div className="px-5 pt-1 flex gap-2 border-b border-border-subtle">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => { vibrate(); setActiveTab(t.id); }}
                className={`px-3 py-2 -mb-px text-xs font-semibold border-b-2 transition-colors duration-150 ${activeTab === t.id ? "text-brand-400 border-brand-500" : "text-text-muted border-transparent hover:text-text"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Current */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-text-muted">
                {selected ? "Click another to swap, or Remove below" : "Click to select"}
              </div>
              {hasRemovable && (
                <button
                  onClick={handleRemove}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 size={14} /> Remove
                </button>
              )}
            </div>

            <div className="space-y-1.5 p-2 rounded-brand bg-surface-2">
              {rows.map((row, rIdx) => (
                <div key={rIdx} className={ROW_CLASS}>
                  {row.map((id, cIdx) => {
                    const k = poolMap.get(id);
                    return (
                      <KeyBtn
                        key={id + cIdx}
                        label={k?.label || id}
                        selected={isSelected(rIdx, cIdx)}
                        onClick={() => handleCurrentClick(rIdx, cIdx, false)}
                      />
                    );
                  })}
                  <PlusBtn
                    selected={isSelected(rIdx, row.length)}
                    onClick={() => handleCurrentClick(rIdx, row.length, true)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Available */}
          <div>
            <div className="text-xs text-text-muted mb-2">
              Available — click to {selected ? (hasRemovable ? "replace selected" : "add to slot") : "add"}
            </div>
            <div className="flex flex-wrap gap-1.5 p-2 rounded-brand bg-surface-2">
              {available.length === 0 && (
                <div className="text-xs text-text-muted italic">All keys added.</div>
              )}
              {available.map(k => (
                <KeyBtn key={k.id} label={k.label} onClick={() => handleAvailableClick(k.id)} />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 flex items-center justify-between">
          <button
            onClick={() => { vibrate(); reset(); setSelected(null); }}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
          >
            ↺ Reset to default
          </button>
          <button
            onClick={() => { vibrate(); onClose(); }}
            className="px-4 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold rounded-brand transition-all duration-150 ease-out active:scale-[0.97]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
