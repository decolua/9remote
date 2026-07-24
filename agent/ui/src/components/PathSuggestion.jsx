import { useEffect, useRef } from "preact/hooks";
import Icon from "./Icon";

// Path suggestion dropdown: mirrors CommandSuggestions styling. Items carry a
// ready-to-insert full command string ("verb path/"). Click → onSelect(full).
export default function PathSuggestion({ items, onSelect, activeIndex = -1 }) {
  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el || activeIndex < 0) return;
    const child = el.children[activeIndex];
    if (child) child.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!items?.length) return null;
  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 rounded-lg overflow-hidden z-30 shadow-lg"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <div ref={listRef} className="flex flex-col max-h-[25vh] overflow-y-auto">
        {items.map((it, idx) => (
          <button
            key={`${it.type}-${it.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect?.(it.full)}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act ${idx === activeIndex ? "bg-brand-500/15" : ""}`}
            style={{ color: "var(--text-main)" }}
          >
            <Icon name={it.type === "folder" ? "folder" : "fileText"} size={13} />
            <span
              className="font-mono"
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", unicodeBidi: "plaintext" }}
              title={it.full}
            >
              {it.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
