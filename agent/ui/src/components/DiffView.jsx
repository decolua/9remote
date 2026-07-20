import { useState, useEffect } from "preact/hooks";
import Icon from "./Icon";
import { parseDiffPath } from "../lib/fileExplorer/constants";

// Plain diff renderer (no diff2html). Renders unified diff as colored rows.
function parseRows(text) {
  const rows = [];
  let oldLn = 0, newLn = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("diff --git")) rows.push({ type: "file", text: line.replace("diff --git a/", "").split(" b/")[0] });
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); }
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ type: "add", text: line.slice(1), newLn: newLn++ });
    else if (line.startsWith("-")) rows.push({ type: "del", text: line.slice(1), oldLn: oldLn++ });
    else rows.push({ type: "ctx", text: line.slice(1), oldLn: oldLn++, newLn: newLn++ });
  }
  return rows;
}

export default function DiffView({ diffPath, workspace, fileSocket, onOpenFile }) {
  const { status, absPath } = parseDiffPath(diffPath);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fileSocket.gitDiff(workspace, absPath, status).then((r) => {
      if (cancelled) return;
      if (r.success) setDiff(r.diff);
      else setError(r.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffPath]);

  const handleOpen = () => {
    if (!onOpenFile || !absPath) return;
    onOpenFile(absPath);
  };

  if (loading) return <div className="h-full flex items-center justify-center text-text-muted">Loading diff…</div>;
  if (error) return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;

  const rows = parseRows(diff);
  return (
    <div className="h-full flex flex-col bg-surface font-mono text-[12.5px] leading-[1.6]">
      {onOpenFile && absPath && (
        <div className="flex items-center justify-end py-1 px-3 bg-surface-2 border-b border-border flex-shrink-0">
          <button
            type="button"
            onClick={handleOpen}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-text-muted hover:text-text hover:bg-surface-3 rounded-brand transition-colors"
            title="Open file"
          >
            <Icon name="externalLink" size={12} />
            <span>Open file</span>
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
      {rows.map((row, i) => {
        if (row.type === "file") return <div key={i} className="px-3 py-2 bg-surface-2 text-text font-semibold break-all">{row.text}</div>;
        if (row.type === "hunk") return <div key={i} className="px-3 py-1 bg-surface-2/60 text-text-muted select-none break-all">{row.text}</div>;
        const gutter = row.type === "add" ? row.newLn : row.type === "del" ? row.oldLn : row.newLn;
        const bg = row.type === "add" ? "bg-[rgba(var(--success-rgb),0.14)]" : row.type === "del" ? "bg-[rgba(var(--danger-rgb),0.14)]" : "";
        const signColor = row.type === "add" ? "text-[var(--success)]" : row.type === "del" ? "text-[var(--danger)]" : "text-text-subtle";
        const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
        return (
          <div key={i} className={`flex ${bg}`}>
            <span className="shrink-0 w-9 px-1 text-right text-text-subtle bg-black/5 select-none">{gutter}</span>
            <span className={`shrink-0 w-4 text-center font-bold ${signColor} select-none`}>{sign}</span>
            <span className="flex-1 min-w-0 pr-2 whitespace-pre-wrap break-words text-text">{row.text || " "}</span>
          </div>
        );
      })}
      </div>
    </div>
  );
}
