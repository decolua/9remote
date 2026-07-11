import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import Icon from "./Icon";
import { vibrate } from "../lib/vibrate";

const COMMANDS = [
  { id: "openExplorer", label: "View: Show Explorer", icon: "folderOpen", shortcut: "" },
  { id: "openSearch", label: "View: Show Search", icon: "search", shortcut: "" },
  { id: "openScm", label: "View: Show Source Control", icon: "gitBranch", shortcut: "" },
  { id: "openSettings", label: "View: Show Settings", icon: "settings", shortcut: "" },
  { id: "toggleSidebar", label: "View: Toggle Sidebar Visibility", icon: "panelLeft", shortcut: "Ctrl+B" },
  { id: "togglePanel", label: "View: Toggle Terminal Panel", icon: "terminalSquare", shortcut: "Ctrl+J" },
  { id: "closeAll", label: "View: Close All Editors", icon: "x", shortcut: "" },
  { id: "switchWorkspace", label: "Workspaces: Switch Workspace", icon: "folder", shortcut: "Ctrl+R" },
];

const SEARCH_DEBOUNCE_MS = 200;
const COMMAND_PREFIX = ">";

export default function CommandPalette({ mode = "files", onSetMode, workspace, fileSocket, onClose, onOpenFile, onAction }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  }, [query]);

  const items = mode === "commands" ? commands : results;

  useEffect(() => { setSelected(0); }, [mode, query, results]);

  useEffect(() => {
    if (mode !== "files") return;
    const q = query.trim();
    if (!q || !fileSocket || !workspace) { setResults([]); setLoading(false); return; }
    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const res = await fileSocket.searchFiles(workspace, q);
      setResults(res?.success && Array.isArray(res.files) ? res.files : []);
      setLoading(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, mode, fileSocket, workspace]);

  const handleChange = useCallback((e) => {
    const value = e.target.value;
    if (mode === "files" && value.startsWith(COMMAND_PREFIX)) {
      onSetMode?.("commands");
      setQuery(value.slice(1));
      return;
    }
    setQuery(value);
  }, [mode, onSetMode]);

  const handleSelect = useCallback((index) => {
    const item = items[index];
    if (!item) return;
    vibrate(8);
    if (mode === "commands") onAction?.(item.id);
    else onOpenFile?.(item.path);
    onClose?.();
  }, [items, mode, onAction, onOpenFile, onClose]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose?.(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(items.length - 1, 0))); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); handleSelect(selected); }
  }, [items.length, selected, onClose, handleSelect]);

  const placeholder = mode === "files" ? "Search files by name…" : "Type a command…";
  const hint = mode === "files" ? "Type `>` for commands" : "Type `?` for help";

  const renderEmpty = () => {
    if (mode === "files" && !query.trim()) {
      return <div className="px-4 py-10 text-center text-text-muted text-sm">Start typing to search files in workspace</div>;
    }
    if (loading) {
      return (
        <div className="px-4 py-6 text-center text-text-muted text-sm flex items-center justify-center gap-2">
          <Icon name="loader2" size={14} className="animate-spin" /> Searching…
        </div>
      );
    }
    return <div className="px-4 py-10 text-center text-text-muted text-sm">No results</div>;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onMouseDown={onClose}>
      <div
        className="absolute top-20 left-1/2 -translate-x-1/2 w-[640px] max-w-[90vw] card-elev bg-surface border border-border rounded-brand overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Icon name={mode === "commands" ? "command" : "search"} size={16} className="text-text-muted" />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent outline-none border-0 text-text placeholder:text-text-muted text-sm"
          />
          <span className="text-xs text-text-muted hidden sm:inline">{hint}</span>
        </div>

        <div className="max-h-[400px] overflow-auto">
          {items.length === 0 ? renderEmpty() : (
            <ul className="py-1">
              {items.map((item, idx) => {
                const isSelected = idx === selected;
                if (mode === "commands") {
                  return (
                    <li
                      key={item.id}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => handleSelect(idx)}
                      className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${isSelected ? "bg-brand-500/20 text-text" : "text-text-muted hover:bg-surface-2"}`}
                    >
                      <Icon name={item.icon} size={16} />
                      <span className="flex-1 text-sm">{item.label}</span>
                      {item.shortcut ? <kbd className="text-xs text-text-muted px-1.5 py-0.5 bg-surface-2 rounded">{item.shortcut}</kbd> : null}
                    </li>
                  );
                }
                const name = item.name || (item.path ? item.path.split(/[\\/]/).pop() : "");
                const rel = item.relativePath || item.path || "";
                return (
                  <li
                    key={item.path || idx}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => handleSelect(idx)}
                    className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${isSelected ? "bg-brand-500/20 text-text" : "text-text-muted hover:bg-surface-2"}`}
                  >
                    <Icon name="file" size={16} />
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="text-sm font-semibold text-text truncate">{name}</span>
                      <span className="text-xs text-text-muted truncate">{rel}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
