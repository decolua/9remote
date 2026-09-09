// test-claude-web/src/components/input/AutocompleteMenu.jsx
import React, { useEffect, useRef } from "react";

function getFileIcon(filename = "") {
  if (filename.endsWith(".jsx") || filename.endsWith(".tsx")) return "⚛️";
  if (filename.endsWith(".js") || filename.endsWith(".mjs") || filename.endsWith(".ts")) return "⚡";
  if (filename.endsWith(".json")) return "📦";
  if (filename.endsWith(".html")) return "🌐";
  if (filename.endsWith(".css")) return "🎨";
  if (filename.endsWith(".md")) return "📝";
  if (filename.endsWith(".sh")) return "🐚";
  if (filename.startsWith(".")) return "⚙️";
  return "📄";
}

export function AutocompleteMenu({
  type = "command", // 'command' | 'submenu' | 'file'
  items = [],
  selectedIndex = 0,
  onSelect,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.children[selectedIndex];
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-2 w-full max-w-xl bg-slate-900/95 border border-white/15 rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="px-3 py-1.5 bg-white/5 border-b border-white/10 text-[11px] font-mono text-slate-400 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-medium">
          {type === "file" && "📁 Chọn file đính kèm (@)"}
          {type === "command" && "⚡ Slash Commands & Skills (/)"}
          {type === "submenu" && "⚙️ Chọn tùy chọn phụ"}
        </span>
        <span className="text-[10px] text-slate-500">↑↓ Điều hướng • Enter / Tab Chọn • Esc Đóng</span>
      </div>

      <div ref={listRef} className="max-h-60 overflow-y-auto p-1 flex flex-col gap-0.5">
        {items.map((item, idx) => {
          const isSelected = idx === selectedIndex;

          if (type === "file") {
            const filePath = typeof item === "string" ? item : item.path;
            const fileName = typeof item === "string" ? item.split("/").pop() : item.name;
            const fileDir = typeof item === "string" ? item.slice(0, -fileName.length - 1) : item.dir;
            const isModified = typeof item === "object" ? item.isModified : false;

            return (
              <button
                key={idx}
                type="button"
                onClick={() => onSelect(filePath)}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-xs font-mono flex items-center justify-between transition-colors gap-2 ${
                  isSelected ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span>{getFileIcon(fileName)}</span>
                  <span className="font-semibold text-white truncate">{fileName}</span>
                  {fileDir && (
                    <span className={`text-[11px] truncate ${isSelected ? "text-blue-200" : "text-slate-500"}`}>
                      {fileDir}
                    </span>
                  )}
                </div>

                {isModified && (
                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono flex-shrink-0 ${
                    isSelected ? "bg-white/20 text-white" : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                  }`}>
                    M
                  </span>
                )}
              </button>
            );
          }

          if (type === "submenu") {
            return (
              <button
                key={idx}
                type="button"
                onClick={() => onSelect(item)}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                  isSelected ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold">{item.label}</span>
                  {item.desc && (
                    <span className={`text-[11px] ${isSelected ? "text-blue-100" : "text-slate-400"}`}>
                      {item.desc}
                    </span>
                  )}
                </div>
              </button>
            );
          }

          // Command / Skill
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelect(item)}
              className={`w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                isSelected ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold text-sky-400 group-hover:text-white">
                  {item.name}
                </span>
                <span className={`text-[11px] truncate max-w-sm ${isSelected ? "text-blue-100" : "text-slate-400"}`}>
                  {item.description}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {item.hasSubmenu && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    isSelected ? "bg-white/20 text-white" : "bg-white/5 text-slate-400"
                  }`}>
                    submenu ▶
                  </span>
                )}
                {item.category && (
                  <span className={`text-[10px] uppercase tracking-wider font-mono ${
                    isSelected ? "text-blue-200" : "text-slate-500"
                  }`}>
                    {item.category}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
