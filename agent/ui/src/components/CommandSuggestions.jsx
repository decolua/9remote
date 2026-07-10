import { useMemo, useState } from "preact/hooks";
import Icon from "./Icon";

const MAX_ITEMS = 6;

// Prefix hits rank above substring; shorter commands first.
const scoreOf = (key, q) => {
  const idx = key.indexOf(q);
  if (idx < 0) return null;
  return (idx === 0 ? 0 : 1000) + idx + key.length * 0.1;
};

// Inline suggestions floating above the input, ranked from history + common commands.
export default function CommandSuggestions({ value, history = [], commonCommands = [], onSelect }) {
  const [dismissed, setDismissed] = useState("");

  const items = useMemo(() => {
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
  }, [value, history, commonCommands]);

  if (items.length === 0 || dismissed === value) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 rounded-lg overflow-hidden z-30 shadow-lg"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      {items.map((it) => (
        <button
          key={it.cmd}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onSelect?.(it.cmd); setDismissed(""); }}
          className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act"
          style={{ color: "var(--text-main)" }}
        >
          <Icon name={it.type === "history" ? "cornerDownLeft" : "terminal"} size={13} />
          <span className="truncate font-mono">{it.cmd}</span>
        </button>
      ))}
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
