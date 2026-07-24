import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Icon from "./Icon";

const MAX_ITEMS = 6;

// Prefix hits rank above substring; shorter commands first.
const scoreOf = (key, q) => {
  const idx = key.indexOf(q);
  if (idx < 0) return null;
  return (idx === 0 ? 0 : 1000) + idx + key.length * 0.1;
};

// Pure item picker — shared with parents that need the same ranked list to drive
// keyboard navigation (Tab cycling) outside this component.
export function pickCommandItems(value, history = [], commonCommands = []) {
  const q = value.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set();
  const out = [];
  const collect = (list, type) => {
    for (const cmd of list) {
      const key = cmd.toLowerCase();
      if (!cmd || key === q || seen.has(key)) continue;
      const score = scoreOf(key, q);
      if (score === null) continue;
      seen.add(key);
      out.push({ cmd, type, score });
    }
  };
  collect(history, "history");
  collect(commonCommands, "common");
  return out.sort((a, b) => a.score - b.score).slice(0, MAX_ITEMS);
}

// Inline command suggestions floating above the input, ranked from history + common commands.
export default function CommandSuggestions({ value, history = [], commonCommands = [], onSelect, activeIndex = -1 }) {
  const [dismissed, setDismissed] = useState("");
  const listRef = useRef(null);

  const items = useMemo(() => pickCommandItems(value, history, commonCommands), [value, history, commonCommands]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || activeIndex < 0) return;
    const child = el.children[activeIndex];
    if (child) child.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0 || dismissed === value) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 rounded-lg overflow-hidden z-30 shadow-lg"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <div ref={listRef} className="flex flex-col max-h-[25vh] overflow-y-auto">
        {items.map((it, idx) => (
          <button
            key={it.cmd}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onSelect?.(it.cmd); setDismissed(""); }}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act ${idx === activeIndex ? "bg-brand-500/15" : ""}`}
            style={{ color: "var(--text-main)" }}
          >
            <Icon name={it.type === "history" ? "cornerDownLeft" : "terminal"} size={13} />
            <span className="truncate font-mono">{it.cmd}</span>
          </button>
        ))}
      </div>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setDismissed(value)}
        className="w-full text-left px-3 py-1 text-xs card-act"
        style={{ color: "var(--text-muted)" }}
      >
        <Icon name="x" size={11} className="inline" /> dismiss
      </button>
    </div>
  );
}
